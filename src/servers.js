/**
 * The set of Jellyfin servers, managed from the Admin page.
 *
 * Each server has a stable `slot` (0-8). The slot is what gets encoded into item ids, so
 * re-ordering or renaming servers never breaks existing links. Order (`position`) is the
 * priority used when a title exists on several servers.
 *
 * Credentials are stored encrypted (crypto.js) and are never returned by the API.
 * Changes apply live: a new/edited/removed server is (re)connected immediately and the
 * registry emits "changed" so the catalogue can reload.
 */
import { EventEmitter } from 'node:events';
import { JellyfinServer } from './jellyfin.js';
import { encrypt, decrypt } from './crypto.js';
import { transaction } from './db.js';
import { HttpError } from './http-error.js';

export const MAX_SERVERS = 9;

function cleanUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
    if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
  } catch {
    throw new HttpError(400, 'URL must be a full http(s) address, e.g. http://192.168.1.10:8096');
  }
  u.hash = '';
  u.search = '';
  return u.toString().replace(/\/+$/, '');
}

export class ServerRegistry extends EventEmitter {
  /** @param {{db, key:Buffer, settings: import('./settings.js').Settings}} deps */
  constructor({ db, key, settings }) {
    super();
    this.db = db;
    this.key = key;
    this.settings = settings;
    this.live = new Map(); // slot -> JellyfinServer
    this.broken = new Map(); // slot -> why it could not be started (e.g. unreadable credentials)
    this.monitoring = false;

    settings.on('change', (keys) => {
      for (const s of this.live.values()) s.timeoutMs = settings.values.requestTimeoutMs;
      if (keys.includes('healthIntervalSeconds') && this.monitoring) this.startMonitors();
    });
    for (const row of this.rows()) this._connect(row);
  }

  // ------------------------------------------------------------------ reading

  rows() {
    return this.db.prepare('SELECT * FROM servers ORDER BY position, slot').all();
  }

  /** Enabled, working servers in priority order. */
  list() {
    return this.rows().filter((r) => this.live.has(r.slot)).map((r) => this.live.get(r.slot));
  }

  get(slot) {
    return this.live.get(slot);
  }

  /** Priority rank of a slot (0 = highest), or Infinity if it isn't active. */
  rank(slot) {
    const i = this.list().findIndex((s) => s.index === slot);
    return i < 0 ? Infinity : i;
  }

  /** Admin view: everything except secrets. */
  describe() {
    return this.rows().map((r) => {
      const s = this.live.get(r.slot);
      return {
        slot: r.slot,
        name: r.name,
        url: r.url,
        authType: r.auth_type,
        username: r.hint_user || '',
        enabled: !!r.enabled,
        position: r.position,
        online: s ? s.online : null,
        authError: s?.authError || null,
        latencyMs: s?.latencyMs ?? null,
        version: s?.info?.version || null,
        lastError: s && s.online === false ? s.lastError : null,
        problem: this.broken.get(r.slot) || null,
      };
    });
  }

  // ---------------------------------------------------------------- lifecycle

  _cfgFromRow(row) {
    const secret = JSON.parse(decrypt(this.key, row.secret));
    return {
      name: row.name,
      url: row.url,
      apiKey: row.auth_type === 'apikey' ? secret.apiKey : null,
      username: row.auth_type === 'login' ? secret.username : row.hint_user || null,
      password: row.auth_type === 'login' ? secret.password : null,
    };
  }

  _connect(row) {
    this._disconnect(row.slot);
    this.broken.delete(row.slot);
    if (!row.enabled) return;
    try {
      const srv = new JellyfinServer(this._cfgFromRow(row), row.slot, { timeoutMs: this.settings.values.requestTimeoutMs });
      this.live.set(row.slot, srv);
      srv.on('online', () => this.emit('serverOnline', row.slot)); // the catalogue reloads it
      if (this.monitoring) srv.startMonitor(this.settings.values.healthIntervalSeconds * 1000);
    } catch {
      this.broken.set(row.slot, 'Stored credentials cannot be decrypted (was RFLIX_SECRET or secret.key changed?). Re-enter them.');
    }
  }

  _disconnect(slot) {
    const s = this.live.get(slot);
    if (s) {
      s.stopMonitor();
      s.removeAllListeners();
      this.live.delete(slot);
    }
  }

  startMonitors() {
    this.monitoring = true;
    for (const s of this.live.values()) {
      s.stopMonitor();
      s.startMonitor(this.settings.values.healthIntervalSeconds * 1000);
    }
  }

  stopMonitors() {
    this.monitoring = false;
    for (const s of this.live.values()) s.stopMonitor();
  }

  // ----------------------------------------------------------------- mutation

  /** Validate admin input and build the DB fields. `existing` allows blank secrets = keep. */
  _normalize(input, existing) {
    const name = String(input.name ?? existing?.name ?? '').trim();
    if (!name || name.length > 60) throw new HttpError(400, 'Give the server a name (up to 60 characters)');
    const url = cleanUrl(input.url ?? existing?.url);
    const authType = input.authType ?? existing?.auth_type;
    if (!['apikey', 'login'].includes(authType)) throw new HttpError(400, 'Choose API key or username/password');

    const prev = existing && existing.auth_type === authType ? JSON.parse(decrypt(this.key, existing.secret)) : {};
    let secret;
    let hint = null;
    if (authType === 'apikey') {
      const apiKey = String(input.apiKey || '').trim() || prev.apiKey;
      if (!apiKey) throw new HttpError(400, 'Enter the API key');
      secret = { apiKey };
      hint = String(input.username ?? (existing?.auth_type === 'apikey' ? existing.hint_user : '') ?? '').trim() || null;
    } else {
      const username = String(input.username || '').trim() || prev.username;
      const password = String(input.password || '') || prev.password;
      if (!username || !password) throw new HttpError(400, 'Enter the Jellyfin username and password');
      secret = { username, password };
      hint = username;
    }
    return { name, url, authType, secret: encrypt(this.key, JSON.stringify(secret)), hint, enabled: input.enabled ?? !!(existing?.enabled ?? true) };
  }

  add(input) {
    const row = transaction(this.db, () => {
      const used = new Set(this.db.prepare('SELECT slot FROM servers').all().map((r) => r.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      if (slot >= MAX_SERVERS) throw new HttpError(409, `At most ${MAX_SERVERS} servers are supported`);
      const f = this._normalize(input, null);
      const position = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM servers').get().p);
      this.db
        .prepare('INSERT INTO servers(slot, name, url, auth_type, secret, hint_user, enabled, position, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(slot, f.name, f.url, f.authType, f.secret, f.hint, f.enabled ? 1 : 0, position, Date.now());
      return this.db.prepare('SELECT * FROM servers WHERE slot = ?').get(slot);
    });
    this._connect(row);
    this.emit('changed', { type: 'added', slot: row.slot, reload: true });
    return row.slot;
  }

  update(slot, input) {
    const existing = this.db.prepare('SELECT * FROM servers WHERE slot = ?').get(slot);
    if (!existing) throw new HttpError(404, 'Server not found');
    const f = this._normalize(input, existing);
    // Did anything that requires a fresh connection change?
    const prevSecret = decrypt(this.key, existing.secret);
    const newSecret = decrypt(this.key, f.secret);
    const reconnect = f.url !== existing.url || f.authType !== existing.auth_type || prevSecret !== newSecret || f.hint !== existing.hint_user || f.enabled !== !!existing.enabled;
    this.db
      .prepare('UPDATE servers SET name = ?, url = ?, auth_type = ?, secret = ?, hint_user = ?, enabled = ? WHERE slot = ?')
      .run(f.name, f.url, f.authType, f.secret, f.hint, f.enabled ? 1 : 0, slot);
    const row = this.db.prepare('SELECT * FROM servers WHERE slot = ?').get(slot);
    if (reconnect || !this.live.has(slot)) this._connect(row);
    else this.live.get(slot).name = row.name;
    this.emit('changed', { type: 'updated', slot, reload: reconnect });
  }

  remove(slot) {
    transaction(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM servers WHERE slot = ?').get(slot)) throw new HttpError(404, 'Server not found');
      this.db.prepare('DELETE FROM servers WHERE slot = ?').run(slot);
      this.db.prepare('DELETE FROM user_servers WHERE slot = ?').run(slot);
    });
    this._disconnect(slot);
    this.broken.delete(slot);
    this.emit('changed', { type: 'removed', slot, reload: false });
  }

  /** @param {number[]} slots every slot, highest priority first */
  reorder(slots) {
    const have = this.rows().map((r) => r.slot).sort();
    if (!Array.isArray(slots) || [...slots].sort().join() !== have.join()) throw new HttpError(400, 'Order must list every server exactly once');
    transaction(this.db, () => slots.forEach((slot, i) => this.db.prepare('UPDATE servers SET position = ? WHERE slot = ?').run(i, slot)));
    this.emit('changed', { type: 'reordered', reload: false });
  }

  /** Import servers from the legacy config (start-up only, when none exist). */
  importLegacy(servers) {
    const result = { added: 0, errors: [] };
    for (const s of servers) {
      try {
        this.add(s);
        result.added++;
      } catch (err) {
        result.errors.push(`${s.name}: ${err.message}`);
      }
    }
    return result;
  }

  // -------------------------------------------------------------------- probing

  /**
   * "Test connection" for the Admin form. Uses the typed values (blank secrets fall back to the
   * stored ones when `slot` is given) and saves nothing.
   */
  async probe(input, slot) {
    const existing = slot != null ? this.db.prepare('SELECT * FROM servers WHERE slot = ?').get(slot) : null;
    if (slot != null && !existing) throw new HttpError(404, 'Server not found');
    const f = this._normalize({ ...input, name: input.name || existing?.name || 'test' }, existing);
    const secret = JSON.parse(decrypt(this.key, f.secret));
    const srv = new JellyfinServer(
      {
        name: f.name,
        url: f.url,
        apiKey: f.authType === 'apikey' ? secret.apiKey : null,
        username: f.authType === 'login' ? secret.username : f.hint,
        password: f.authType === 'login' ? secret.password : null,
      },
      99,
      { timeoutMs: 6000 },
    );
    await srv.checkHealth();
    if (srv.online === false) return { ok: false, step: 'connect', error: `Cannot reach the server: ${srv.lastError}` };
    let auth;
    try {
      auth = await srv.auth();
    } catch (err) {
      return { ok: false, step: 'auth', error: err.status === 401 || err.status === 403 ? 'The server rejected the API key / login' : err.message };
    }
    let users = null;
    try {
      users = await srv.users();
    } catch {
      /* not an admin: can't list users, so per-user mapping isn't available on this server */
    }
    const me = users?.find((u) => u.id === auth.userId);
    return {
      ok: true,
      serverName: srv.info?.serverName || null,
      version: srv.info?.version || null,
      catalogueUser: me?.name || null,
      canMapUsers: !!users,
      userCount: users?.length ?? null,
    };
  }

  /** Jellyfin users on a configured server (for the mapping dropdowns). */
  async jellyfinUsers(slot) {
    const srv = this.live.get(slot);
    if (!srv) throw new HttpError(404, 'Server not found or disabled');
    try {
      return await srv.users();
    } catch (err) {
      throw new HttpError(502, err.status === 403 ? 'This server\'s credentials cannot list users (use an API key or an admin login)' : `Cannot list users: ${err.message}`);
    }
  }
}
