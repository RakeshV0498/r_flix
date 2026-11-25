/**
 * Minimal Jellyfin REST client — one instance per configured server.
 *
 * Responsibilities:
 *  - authentication (API key, or username/password -> access token), done lazily
 *    and re-done automatically if the token is rejected;
 *  - a health monitor that drives the online/offline indicator and emits
 *    "online"/"offline" events;
 *  - thin typed helpers for the handful of endpoints r_flix needs.
 *
 * Only network-level failures (refused, timeout, DNS) mark a server offline.
 * Any HTTP response — even 401/500 — proves the server is reachable.
 */
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import os from 'node:os';

export class UpstreamError extends Error {
  /**
   * `message` is for the server log and may contain addresses. `publicMessage` is what viewers
   * may see: never an address, port or raw network error.
   */
  constructor(message, { status = 0, network = false, timeout = false, publicMessage, cause } = {}) {
    super(message, { cause });
    this.name = 'UpstreamError';
    this.status = status;
    this.network = network; // could not connect at all
    this.timeout = timeout; // connected (or tried to) but no answer within our limit
    this.publicMessage = publicMessage;
  }
}

const CLIENT_VERSION = '1.0.0';

export class JellyfinServer extends EventEmitter {
  /**
   * @param {object} cfg    normalised server config (see config.js)
   * @param {number} index  position in the config = priority = id digit
   * @param {{timeoutMs?:number}} [opts]
   */
  constructor(cfg, index, { timeoutMs = 8000 } = {}) {
    super();
    this.cfg = cfg;
    this.index = index;
    this.name = cfg.name;
    this.base = cfg.url;
    this.timeoutMs = timeoutMs;
    /** Identifies r_flix to Jellyfin (shows up in its dashboard "Devices"). */
    this.deviceId = `r_flix-${crypto.createHash('sha1').update(os.hostname()).digest('hex').slice(0, 8)}-${index}`;

    // Reachability state (null = not checked yet)
    this.online = null;
    this.lastError = null;
    this.authError = null;
    this.latencyMs = null;
    this.lastChecked = 0;
    this.info = null; // { serverName, version } from /System/Info/Public

    this._auth = null; // { token, userId }
    this._authPromise = null;
    this._compat = new Map(); // remembers which API path variant worked
    this._timer = null;
  }

  // ------------------------------------------------------------------ URLs

  /** Build an absolute upstream URL. `query` may be an object or a ready string. */
  url(pathname, query) {
    const u = new URL(this.base + pathname);
    if (typeof query === 'string') u.search = query;
    else for (const [k, v] of Object.entries(query || {})) if (v != null) u.searchParams.set(k, String(v));
    return u;
  }

  _authHeader(token) {
    const base = `MediaBrowser Client="r_flix", Device="r_flix", DeviceId="${this.deviceId}", Version="${CLIENT_VERSION}"`;
    return token ? `${base}, Token="${token}"` : base;
  }

  // ------------------------------------------------------------ reachability

  _markUp() {
    const was = this.online;
    this.online = true;
    this.lastError = null;
    if (was !== true) this.emit(was === false ? 'online' : 'change');
  }

  _markDown(err) {
    const was = this.online;
    this.online = false;
    this.lastError = err?.message || 'unreachable';
    if (was !== false) this.emit('offline');
  }

  /** Ping the public info endpoint (no auth needed). Never throws. */
  async checkHealth() {
    const t0 = performance.now();
    try {
      const { res, clear } = await this._request('/System/Info/Public', { timeoutMs: 4000, markDownOnTimeout: true });
      try {
        if (res.ok) {
          const j = await res.json();
          this.info = { serverName: j.ServerName, version: j.Version };
        }
      } finally {
        clear();
      }
      this.latencyMs = Math.round(performance.now() - t0);
    } catch {
      this.latencyMs = null; // _request already marked us down
    }
    this.lastChecked = Date.now();
  }

  /** Start periodic health checks (first one runs immediately). */
  startMonitor(intervalMs) {
    this.checkHealth();
    this._timer = setInterval(() => this.checkHealth(), intervalMs);
    this._timer.unref();
  }

  stopMonitor() {
    clearInterval(this._timer);
  }

  // --------------------------------------------------------------- transport

  /**
   * Low-level fetch. Returns { res, clear } — call clear() once the body has
   * been consumed (the timeout stays armed while reading the body).
   * Set `stream: true` to disarm the timeout as soon as headers arrive
   * (used for long-lived video/image streams).
   */
  async _request(pathname, o = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('timeout')), o.timeoutMs ?? this.timeoutMs);
    const clear = () => clearTimeout(timer);
    const signal = o.signal ? AbortSignal.any([o.signal, ctl.signal]) : ctl.signal;

    const headers = { Accept: 'application/json', Authorization: this._authHeader(o.token), ...(o.headers || {}) };
    if (o.token) headers['X-Emby-Token'] = o.token; // legacy header, harmless on new servers
    let body;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['Content-Type'] = 'application/json';
    }

    let res;
    try {
      // redirect:'manual' so our token is never forwarded to some other host.
      res = await fetch(this.url(pathname, o.query), { method: o.method || 'GET', headers, body, signal, redirect: 'manual' });
    } catch (err) {
      clear();
      if (o.signal?.aborted) throw err; // the *caller* gave up (e.g. browser closed the tab): not a server fault
      if (ctl.signal.aborted) {
        // OUR time limit ran out: the server is slow (starting a transcode, waking a disk, reading a
        // cloud file...), not necessarily down. Only the periodic health check may call it offline;
        // otherwise one slow video start would take the whole server out of service.
        if (o.markDownOnTimeout) this._markDown(new Error('timed out'));
        throw new UpstreamError(`${this.name}: no response within ${Math.round((o.timeoutMs ?? this.timeoutMs) / 1000)}s`, {
          timeout: true,
          cause: err,
          publicMessage: `${this.name} is taking too long to respond`,
        });
      }
      this._markDown(err.cause || err);
      throw new UpstreamError(`${this.name}: unreachable (${(err.cause || err).message})`, {
        network: true,
        cause: err,
        publicMessage: `${this.name} is not responding`,
      });
    }
    this._markUp();
    if (res.status >= 300 && res.status < 400) {
      clear();
      throw new UpstreamError(`${this.name}: unexpected redirect to ${res.headers.get('location')}; set the final address in Admin`, {
        status: res.status,
        publicMessage: `${this.name} is misconfigured (it redirected the request)`,
      });
    }
    if (o.stream) clear();
    return { res, clear };
  }

  /** Resolve (and cache) the access token + user id for this server. */
  auth() {
    if (this._auth) return Promise.resolve(this._auth);
    this._authPromise ??= this._authenticate()
      .then((a) => {
        this._auth = a;
        this.authError = null;
        return a;
      })
      .catch((err) => {
        this.authError = err.status === 401 || err.status === 403 ? 'Authentication failed' : err.message;
        throw err;
      })
      .finally(() => {
        this._authPromise = null;
      });
    return this._authPromise;
  }

  async _authenticate() {
    const { apiKey, username, password, userId } = this.cfg;
    if (apiKey) {
      return { token: apiKey, userId: userId || (await this._resolveUserId(apiKey)) };
    }
    const { res, clear } = await this._request('/Users/AuthenticateByName', {
      method: 'POST',
      body: { Username: username, Pw: password },
    });
    try {
      if (!res.ok) throw new UpstreamError(`${this.name}: login failed (${res.status})`, { status: res.status });
      const j = await res.json();
      return { token: j.AccessToken, userId: userId || j.User.Id.replace(/-/g, '') };
    } finally {
      clear();
    }
  }

  /** With only an API key we still need a user (watch state is per user). */
  async _resolveUserId(token) {
    const { res, clear } = await this._request('/Users', { token });
    try {
      if (!res.ok) throw new UpstreamError(`${this.name}: cannot list users (${res.status})`, { status: res.status });
      const users = await res.json();
      const want = this.cfg.username?.toLowerCase();
      const user =
        (want && users.find((u) => u.Name.toLowerCase() === want)) ||
        users.find((u) => u.Policy?.IsAdministrator && !u.Policy?.IsDisabled) ||
        users[0];
      if (!user) throw new UpstreamError(`${this.name}: no users found`);
      return user.Id.replace(/-/g, '');
    } finally {
      clear();
    }
  }

  /** Authenticated request; on 401 with a password login, log in again once. */
  async _authed(pathname, o = {}) {
    for (let attempt = 0; ; attempt++) {
      const { token } = await this.auth();
      const r = await this._request(pathname, { ...o, token });
      if (r.res.status === 401 && !this.cfg.apiKey && attempt === 0) {
        r.clear();
        await r.res.body?.cancel().catch(() => {});
        this._auth = null; // token expired/revoked
        continue;
      }
      if (r.res.status === 401 || r.res.status === 403) this.authError = 'Authentication failed';
      return r;
    }
  }

  /** Authenticated JSON request. Throws UpstreamError on non-2xx. */
  async json(pathname, o = {}) {
    const { res, clear } = await this._authed(pathname, o);
    try {
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new UpstreamError(`${this.name}: ${o.method || 'GET'} ${pathname} -> ${res.status}`, { status: res.status });
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clear();
    }
  }

  /** Authenticated raw request for proxying (headers only; caller streams body). */
  raw(pathname, o = {}) {
    return this._authed(pathname, { ...o, stream: true });
  }

  /**
   * Jellyfin renamed several user-scoped routes between versions
   * (/Users/{id}/Items/Resume -> /UserItems/Resume ...). Try each variant in
   * turn and remember which one this server understands.
   */
  async jsonCompat(key, variants, o = {}) {
    const pref = this._compat.get(key) ?? 0;
    const order = [pref, ...variants.keys()].filter((v, i, a) => a.indexOf(v) === i);
    let err;
    for (const i of order) {
      try {
        const out = await this.json(variants[i].path, { ...o, query: variants[i].query ?? o.query });
        this._compat.set(key, i);
        return out;
      } catch (e) {
        err = e;
        if (!(e instanceof UpstreamError) || (e.status !== 404 && e.status !== 405)) throw e;
      }
    }
    throw err;
  }

  // ------------------------------------------------------------- API helpers

  async userId() {
    return (await this.auth()).userId;
  }

  /** One page of the user's movies + series (the library catalogue). */
  async libraryPage(startIndex, limit) {
    return this.json('/Items', {
      query: {
        userId: await this.userId(),
        Recursive: true,
        IncludeItemTypes: 'Movie,Series',
        Fields: 'ProviderIds,Overview,Genres,DateCreated',
        SortBy: 'DateCreated',
        SortOrder: 'Descending',
        StartIndex: startIndex,
        Limit: limit,
        EnableTotalRecordCount: true,
      },
    });
  }

  // The methods below take the Jellyfin user to act as. With an API key (or an admin login)
  // r_flix can act as any user on the server, which is how each r_flix user gets their own
  // watch history. Omit it to act as the server's default ("catalogue") user.

  /** "Continue watching": partially watched movies/episodes, newest first. */
  async resume(userId, limit = 20) {
    userId ||= await this.userId();
    const query = { userId, Limit: limit, MediaTypes: 'Video', Fields: 'Overview', EnableTotalRecordCount: false };
    const r = await this.jsonCompat('resume', [
      { path: '/UserItems/Resume', query },
      { path: `/Users/${userId}/Items/Resume`, query },
    ]);
    return r?.Items || [];
  }

  /** Next unwatched episode of each series the user is following. */
  async nextUp(userId, limit = 20) {
    const r = await this.json('/Shows/NextUp', {
      query: { userId: userId || (await this.userId()), Limit: limit, Fields: 'Overview', EnableTotalRecordCount: false },
    });
    return r?.Items || [];
  }

  /** Full details for one item (cast, studios, ...), including this user's watch state. */
  async item(id, userId) {
    const r = await this.json('/Items', {
      query: { userId: userId || (await this.userId()), Ids: id, Fields: 'Overview,People,Genres,Studios,Taglines,ProviderIds' },
    });
    return r?.Items?.[0] || null;
  }

  /** Every episode of a series (all seasons). */
  async episodes(seriesId, userId) {
    const r = await this.json(`/Shows/${seriesId}/Episodes`, {
      query: { userId: userId || (await this.userId()), Fields: 'Overview', isMissing: false },
    });
    return r?.Items || [];
  }

  /** Ask Jellyfin whether the item can be direct-played, and how to transcode if not. */
  async playbackInfo(id, body, userId) {
    userId ||= await this.userId();
    // Generous timeout: the first request for a file makes Jellyfin probe it, which can take a while
    // on a small server or a slow/remote disk.
    return this.json(`/Items/${id}/PlaybackInfo`, { method: 'POST', query: { userId }, body: { UserId: userId, ...body }, timeoutMs: 30_000 });
  }

  /** Playback session reports: kind = '' (start) | 'Progress' | 'Stopped'. */
  async reportPlayback(kind, body) {
    await this.json(`/Sessions/Playing${kind ? `/${kind}` : ''}`, { method: 'POST', body });
  }

  /** Persist resume position / watched flag for the authenticated user. */
  async writeUserData(id, data, userId) {
    userId ||= await this.userId();
    await this.jsonCompat(
      'userdata',
      [
        { path: `/UserItems/${id}/UserData`, query: { userId } },
        { path: `/Users/${userId}/Items/${id}/UserData` },
      ],
      { method: 'POST', body: data },
    );
  }

  /**
   * Watch state of specific items for one user (one request per chunk of ids). Used to overlay
   * each person's own played/progress markers on the shared catalogue.
   * @returns {Promise<Map<string, object>>} jellyfin id -> UserData
   */
  async userStates(ids, userId) {
    userId ||= await this.userId();
    const out = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const r = await this.json('/Items', { query: { userId, Ids: ids.slice(i, i + 100).join(','), EnableTotalRecordCount: false } });
      for (const it of r?.Items || []) out.set(String(it.Id).replace(/-/g, '').toLowerCase(), it.UserData || {});
    }
    return out;
  }

  /** The server's user accounts (needs an API key or admin login): used to map r_flix users. */
  async users() {
    const list = await this.json('/Users');
    return (list || []).map((u) => ({
      id: u.Id.replace(/-/g, '').toLowerCase(),
      name: u.Name,
      isAdmin: !!u.Policy?.IsAdministrator,
      isDisabled: !!u.Policy?.IsDisabled,
    }));
  }

  /**
   * Should playback session reports (Sessions/Playing...) be sent for this Jellyfin user?
   * Jellyfin attributes a session to the *token's* user. An API key has no user, so there is
   * nothing to mis-attribute; with a password login, reporting for anyone but that login user
   * would wrongly write watch history onto the login account — so we don't.
   */
  async sessionMatches(jfUserId) {
    if (this.cfg.apiKey) return true;
    return (await this.userId()) === jfUserId;
  }

  /** Best-effort: tell Jellyfin to stop an ffmpeg transcode for this play session. */
  async stopTranscode(playSessionId) {
    const { res, clear } = await this._authed('/Videos/ActiveEncodings', {
      method: 'DELETE',
      query: { deviceId: this.deviceId, playSessionId },
    });
    clear();
    await res.body?.cancel().catch(() => {});
  }
}
