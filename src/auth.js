/**
 * Accounts and login sessions.
 *
 *  - Passwords: scrypt (built into Node), per-user random salt, async so a login never
 *    blocks the event loop on a slow Pi.
 *  - Sessions: a random 256-bit token in an HttpOnly cookie. Only its SHA-256 is stored,
 *    so a copy of the database can't be used to hijack a session.
 *  - Throttling: repeated failed logins from one address / for one account are slowed down.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { transaction } from './db.js';
import { HttpError } from './http-error.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const SESSION_DAYS = 30;
const DAY = 86_400_000;

export const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

// ------------------------------------------------------------------ passwords

export function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (pw.length > 200) throw new HttpError(400, 'Password is too long');
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

// A throwaway hash so "unknown user" takes as long as "wrong password". Made on first use,
// not at start-up: scrypt briefly needs ~16 MB, which a small device shouldn't pay until a login happens.
let dummyHash;
const dummy = () => (dummyHash ??= hashPassword('not-a-real-password'));

// ---------------------------------------------------------------------- users

const toUser = (row) =>
  row && {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    disabled: !!row.disabled,
    createdAt: row.created_at,
    lastLogin: row.last_login,
  };

export class Users {
  constructor(db) {
    this.db = db;
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  adminCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n;
  }

  get(id) {
    return toUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  list() {
    return this.db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(toUser);
  }

  /** Validate and create. `allowFirstOnly` makes the "no users yet" check atomic (setup wizard). */
  async create({ username, displayName, password, role = 'user' }, { allowFirstOnly = false } = {}) {
    if (!USERNAME_RE.test(username || '')) throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, . _ -');
    checkPasswordPolicy(password);
    if (!['admin', 'user'].includes(role)) throw new HttpError(400, 'Invalid role');
    const name = String(displayName || username).trim().slice(0, 60) || username;
    const password_hash = await hashPassword(password);
    return transaction(this.db, () => {
      if (allowFirstOnly && this.count() > 0) throw new HttpError(409, 'Setup has already been completed');
      if (this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO users(username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(username, name, password_hash, role, Date.now());
      return this.get(Number(lastInsertRowid));
    });
  }

  /** Update profile fields. Refuses to leave the system without an enabled admin. */
  update(id, { displayName, role, disabled }) {
    const user = this.get(id);
    if (!user) throw new HttpError(404, 'User not found');
    const next = {
      display_name: displayName !== undefined ? String(displayName).trim().slice(0, 60) || user.username : user.displayName,
      role: role !== undefined ? role : user.role,
      disabled: disabled !== undefined ? (disabled ? 1 : 0) : user.disabled ? 1 : 0,
    };
    if (!['admin', 'user'].includes(next.role)) throw new HttpError(400, 'Invalid role');
    return transaction(this.db, () => {
      const wasAdmin = user.role === 'admin' && !user.disabled;
      const willBeAdmin = next.role === 'admin' && !next.disabled;
      if (wasAdmin && !willBeAdmin && this.adminCount() <= 1) throw new HttpError(409, 'There must be at least one enabled admin');
      this.db.prepare('UPDATE users SET display_name = ?, role = ?, disabled = ? WHERE id = ?').run(next.display_name, next.role, next.disabled, id);
      if (next.disabled) this.revokeAll(id); // disabling signs the user out everywhere
      return this.get(id);
    });
  }

  async setPassword(id, password) {
    checkPasswordPolicy(password);
    if (!this.get(id)) throw new HttpError(404, 'User not found');
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), id);
  }

  delete(id) {
    const user = this.get(id);
    if (!user) throw new HttpError(404, 'User not found');
    transaction(this.db, () => {
      if (user.role === 'admin' && !user.disabled && this.adminCount() <= 1) throw new HttpError(409, 'Cannot delete the last admin');
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions + mappings cascade
    });
  }

  /** Check credentials. Returns the user, or null (same timing either way). */
  async authenticate(username, password) {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
    const ok = await verifyPassword(String(password || ''), row ? row.password_hash : await dummy());
    if (!row || !ok || row.disabled) return null;
    this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), row.id);
    return toUser(row);
  }

  async verifyCurrentPassword(id, password) {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id);
    return !!row && verifyPassword(String(password || ''), row.password_hash);
  }

  // -- Jellyfin user mappings: which Jellyfin account (per server slot) is this person?

  mappings(id) {
    return Object.fromEntries(this.db.prepare('SELECT slot, jf_user_id FROM user_servers WHERE user_id = ?').all(id).map((r) => [r.slot, r.jf_user_id]));
  }

  setMapping(id, slot, jfUserId) {
    if (!this.get(id)) throw new HttpError(404, 'User not found');
    if (!jfUserId) this.db.prepare('DELETE FROM user_servers WHERE user_id = ? AND slot = ?').run(id, slot);
    else {
      if (!/^[0-9a-f]{32}$/i.test(jfUserId)) throw new HttpError(400, 'Invalid Jellyfin user id');
      this.db
        .prepare('INSERT INTO user_servers(user_id, slot, jf_user_id) VALUES (?, ?, ?) ON CONFLICT(user_id, slot) DO UPDATE SET jf_user_id = excluded.jf_user_id')
        .run(id, slot, jfUserId.toLowerCase());
    }
  }

  clearSlot(slot) {
    this.db.prepare('DELETE FROM user_servers WHERE slot = ?').run(slot);
  }

  // -- sessions

  /** @returns {string} the cookie token */
  createSession(userId, userAgent = '') {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(token), userId, now, now + SESSION_DAYS * DAY, String(userAgent).slice(0, 200));
    return token;
  }

  /** @returns {object|null} the signed-in user for a cookie token (extends the session while in use) */
  sessionUser(token) {
    if (!token) return null;
    const row = this.db
      .prepare('SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
      .get(hashToken(token));
    if (!row || row.expires_at < Date.now() || row.disabled) return null;
    // Sliding expiry, written at most about once a day so reads don't churn the SD card.
    if (row.expires_at - Date.now() < (SESSION_DAYS - 1) * DAY) {
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + SESSION_DAYS * DAY, hashToken(token));
    }
    return toUser(row);
  }

  revoke(token) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  revokeAll(userId, exceptToken) {
    if (exceptToken) this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, hashToken(exceptToken));
    else this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  sessionCount(userId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').get(userId, Date.now()).n;
  }

  cleanup() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }
}

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// ------------------------------------------------------------ login throttling

/**
 * In-memory failed-login throttle. After a few failures a key is locked out for a
 * growing time (1 min, 2 min, ... capped at 15). Keys: "ip|username" and "ip".
 */
export class LoginLimiter {
  constructor({ maxFails = 5, ipMaxFails = 25, acctMaxFails = 10 } = {}) {
    this.maxFails = maxFails;
    this.ipMaxFails = ipMaxFails;
    this.acctMaxFails = acctMaxFails;
    this.map = new Map(); // key -> { fails, until }
    this.timer = setInterval(() => this.prune(), 600_000);
    this.timer.unref();
  }

  /**
   * Three counters: this address + this account, this address overall, and this account from
   * ANYWHERE. The last one matters behind a reverse proxy (RFLIX_TRUST_PROXY), where a client can
   * forge its forwarded address to dodge the per-address counters: guessing one person's password
   * from many "addresses" still hits the account limit.
   */
  keys(ip, username) {
    const name = String(username).toLowerCase();
    return [[`${ip}|${name}`, this.maxFails], [ip, this.ipMaxFails], [`acct|${name}`, this.acctMaxFails]];
  }

  /** @returns {number} seconds to wait, or 0 if allowed */
  wait(ip, username) {
    const now = Date.now();
    let secs = 0;
    for (const [k] of this.keys(ip, username)) {
      const e = this.map.get(k);
      if (e && e.until > now) secs = Math.max(secs, Math.ceil((e.until - now) / 1000));
    }
    return secs;
  }

  fail(ip, username) {
    for (const [k, max] of this.keys(ip, username)) {
      const e = this.map.get(k) || { fails: 0, until: 0 };
      e.fails++;
      if (e.fails >= max) e.until = Date.now() + Math.min(15, 2 ** Math.floor((e.fails - max) / 1)) * 60_000;
      e.touched = Date.now();
      this.map.set(k, e);
    }
  }

  success(ip, username) {
    const name = String(username).toLowerCase();
    this.map.delete(`${ip}|${name}`);
    this.map.delete(`acct|${name}`); // a correct password proves it's the owner
  }

  prune() {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, e] of this.map) if (e.until < Date.now() && (e.touched || 0) < cutoff) this.map.delete(k);
  }
}
