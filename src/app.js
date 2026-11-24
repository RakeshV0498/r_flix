/**
 * Express application: auth, JSON API, admin API, proxy routes and the static front end.
 * Kept separate from server.js so tests can build an app (on an in-memory database)
 * without listening on a port.
 *
 * Access model
 *   public         /api/health, /api/setup/*, /api/auth/*, static files (the login page itself)
 *   signed in      everything else: catalogue, playback, /proxy (video), /api/img (artwork)
 *   admin only     /api/admin/*  (servers, users, mappings, settings, stats)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from './db.js';
import { loadKey } from './crypto.js';
import { Settings, SCHEMA } from './settings.js';
import { ServerRegistry } from './servers.js';
import { Users, LoginLimiter } from './auth.js';
import { Catalogue } from './catalogue.js';
import { UpstreamError } from './jellyfin.js';
import { Playback } from './playback.js';
import { mountProxy, mountImages } from './proxy.js';
import { decodeUid } from './ids.js';
import { HttpError } from './http-error.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const hlsFile = path.join(here, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js');
// The Docker build gzips hls.js once, so the Pi never spends CPU compressing it per request.
const hlsGzFile = `${hlsFile}.gz`;

const COOKIE = 'rflix_session';
const SESSION_MS = 30 * 86_400_000;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const slotParam = (req) => {
  const n = Number(req.params.slot);
  if (!Number.isInteger(n) || n < 0 || n > 8) throw new HttpError(400, 'Bad server id');
  return n;
};
const idParam = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Bad user id');
  return n;
};
const readCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

/**
 * Build everything from a data directory.
 * @param {{dataDir:string, trustProxy?:boolean, legacy?:{servers:object[],settings:object}, env?:object, log?:(msg:string)=>void}} opts
 *   dataDir ':memory:' gives a throwaway in-memory database (tests).
 */
export function createApp({ dataDir, trustProxy = false, legacy = { servers: [], settings: {} }, env = process.env, log = console.log }) {
  if (dataDir !== ':memory:') fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb(dataDir);
  const key = dataDir === ':memory:' ? crypto.randomBytes(32) : loadKey(dataDir, env);
  const settings = new Settings(db);
  const reg = new ServerRegistry({ db, key, settings });
  const users = new Users(db);
  const catalogue = new Catalogue(reg, settings);
  const playback = new Playback(reg, catalogue, settings);
  const limiter = new LoginLimiter();

  // One-time import of a pre-database config.json / JELLYFIN_* environment.
  if (reg.rows().length === 0 && legacy.servers.length) {
    try {
      settings.update(legacy.settings);
    } catch (err) {
      log(`[import] ignoring invalid legacy settings: ${err.message}`);
    }
    const r = reg.importLegacy(legacy.servers);
    log(`[import] imported ${r.added} server(s) from config.json / environment. Manage them on the Admin page from now on.`);
    for (const e of r.errors) log(`[import] skipped ${e}`);
  }

  // Until the first admin exists, creating one needs this code (printed in the server log), so
  // that whoever first reaches a fresh install over the network can't claim it unless they can read the log.
  let setupCode = users.count() === 0 ? env.RFLIX_SETUP_CODE || crypto.randomBytes(4).toString('hex') : null;

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);

  // Everything the page needs comes from this origin (hls.js runs its worker from a blob:).
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  // ---- who is this? (cookie -> user, with their Jellyfin mappings)
  app.use((req, res, next) => {
    const token = readCookie(req, COOKIE);
    const user = token && users.sessionUser(token);
    if (user) {
      req.user = { ...user, map: users.mappings(user.id) };
      req.sessionToken = token;
    }
    next();
  });

  // ---- CSRF: SameSite=Lax cookies already stop cross-site POSTs; also refuse a mismatched Origin.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host === req.get('host');
      } catch {
        /* malformed Origin */
      }
      if (!ok) return res.status(403).json({ error: 'Cross-site request refused' });
    }
    next();
  });

  const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in', code: 'auth' }));
  const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Administrators only' }));

  const startSession = (req, res, userId) => {
    const token = users.createSession(userId, req.get('user-agent'));
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS, path: '/' });
  };
  const me = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role });

  // =========================================================== public
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(express.json({ limit: '16kb' }));

  // The page's first call: fresh install? signed in already? (One request, so a signed-out visitor
  // doesn't trigger a 401 just to find out.)
  api.get('/setup/state', (req, res) => res.json({ needsSetup: users.count() === 0, user: req.user ? me(req.user) : null }));

  api.post('/setup', wrap(async (req, res) => {
    if (users.count() > 0) throw new HttpError(409, 'Setup has already been completed');
    const b = req.body || {};
    const wait = limiter.wait(req.ip, '__setup__');
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait}s.`);
    if (!setupCode || !safeEqual(String(b.code || '').trim().toLowerCase(), setupCode.toLowerCase())) {
      limiter.fail(req.ip, '__setup__');
      throw new HttpError(403, 'Wrong setup code. It is printed in the r_flix server log.');
    }
    const user = await users.create({ username: b.username, displayName: b.displayName, password: b.password, role: 'admin' }, { allowFirstOnly: true });
    setupCode = null;
    startSession(req, res, user.id);
    res.status(201).json(me(user));
  }));

  api.post('/auth/login', wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || username.length > 64) throw new HttpError(400, 'Enter your username and password');
    const wait = limiter.wait(req.ip, username);
    if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${wait}s.`);
    const user = await users.authenticate(username, password);
    if (!user) {
      limiter.fail(req.ip, username);
      throw new HttpError(401, 'Wrong username or password');
    }
    limiter.success(req.ip, username);
    startSession(req, res, user.id);
    res.json(me(user));
  }));

  api.post('/auth/logout', (req, res) => {
    if (req.sessionToken) users.revoke(req.sessionToken);
    res.clearCookie(COOKIE, { path: '/' });
    res.status(204).end();
  });

  // =========================================================== signed in
  api.use(requireAuth);

  api.get('/me', (req, res) => res.json(me(req.user)));
  api.put('/me', wrap(async (req, res) => {
    res.json(me(users.update(req.user.id, { displayName: String(req.body?.displayName ?? '') })));
  }));
  api.post('/me/password', wrap(async (req, res) => {
    const { current, next } = req.body || {};
    if (!(await users.verifyCurrentPassword(req.user.id, current))) throw new HttpError(403, 'Current password is wrong');
    await users.setPassword(req.user.id, next);
    users.revokeAll(req.user.id, req.sessionToken); // sign out other devices
    res.status(204).end();
  }));

  api.get('/status', (req, res) => {
    res.json({
      servers: reg.rows().map((r) => {
        const s = reg.get(r.slot);
        return {
          index: r.slot,
          name: r.name,
          online: !!s && s.online !== false, // unknown (still checking) counts as up until proven otherwise
          checking: !!s && s.online === null,
          authError: s?.authError || null,
          disabled: !r.enabled,
          // Deliberately no address or raw error text: viewers never learn where servers live.
        };
      }).filter((s) => !s.disabled),
    });
  });

  api.get('/home', wrap(async (req, res) => res.json(await catalogue.home(req.user))));

  api.get('/browse', wrap(async (req, res) => {
    await catalogue.ensureLoaded();
    res.json(
      await catalogue.browse(req.user, {
        type: { Movie: 'Movie', Series: 'Series' }[req.query.type],
        genre: req.query.genre ? String(req.query.genre) : undefined,
        sort: String(req.query.sort || 'added'),
        offset: Math.max(0, Number(req.query.offset) || 0),
        limit: Math.min(120, Math.max(1, Number(req.query.limit) || 60)),
      }),
    );
  }));

  api.get('/search', wrap(async (req, res) => {
    await catalogue.ensureLoaded();
    res.json({ items: await catalogue.search(req.user, String(req.query.q || '').slice(0, 100)) });
  }));

  api.get('/items/:uid', wrap(async (req, res) => {
    if (!decodeUid(req.params.uid)) throw new HttpError(400, 'Bad item id');
    await catalogue.ensureLoaded();
    const d = await catalogue.details(req.params.uid, req.user);
    if (!d) throw new HttpError(404, 'Title not found');
    res.json(d);
  }));

  api.get('/items/:uid/episodes', wrap(async (req, res) => {
    await catalogue.ensureLoaded();
    const group = catalogue.groupFor(req.params.uid);
    if (!group || group.type !== 'Series') throw new HttpError(404, 'Series not found');
    res.json({ seasons: (await catalogue.episodesOf(group, req.user)).seasons });
  }));

  api.get('/play/:uid', wrap(async (req, res) => {
    const exclude = new Set(String(req.query.exclude || '').split(',').filter(Boolean).map(Number));
    const start = req.query.start !== undefined ? Number(req.query.start) : undefined;
    res.json(await playback.prepare(req.params.uid, req.user, { exclude, start, forceTranscode: req.query.transcode === '1' }));
  }));

  api.post('/progress', wrap(async (req, res) => {
    const b = req.body || {};
    const ok =
      typeof b.uid === 'string' &&
      ['start', 'progress', 'stop'].includes(b.event) &&
      Number.isFinite(b.positionSeconds) && b.positionSeconds >= 0 && b.positionSeconds < 1e6 &&
      Number.isInteger(b.serverIndex);
    if (!ok) throw new HttpError(400, 'Bad playback report');
    await playback.report(req.user, {
      uid: b.uid,
      event: b.event,
      positionSeconds: b.positionSeconds,
      durationSeconds: Number.isFinite(b.durationSeconds) ? b.durationSeconds : 0,
      playSessionId: String(b.playSessionId || ''),
      serverIndex: b.serverIndex,
      mediaSourceId: String(b.mediaSourceId || ''),
      playMethod: ['DirectPlay', 'DirectStream', 'Transcode'].includes(b.playMethod) ? b.playMethod : 'DirectPlay',
      paused: !!b.paused,
    });
    res.status(204).end();
  }));

  // =========================================================== admin
  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get('/settings', (req, res) => res.json({ values: settings.values, schema: SCHEMA }));
  admin.put('/settings', (req, res) => res.json({ values: settings.update(req.body), schema: SCHEMA }));

  // -- servers
  admin.get('/servers', (req, res) => res.json({ servers: reg.describe() }));
  admin.post('/servers/test', wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await reg.probe(b, b.slot != null ? Number(b.slot) : undefined));
  }));
  admin.post('/servers/reorder', (req, res) => {
    reg.reorder(req.body?.order);
    res.json({ servers: reg.describe() });
  });
  admin.post('/servers', (req, res) => {
    reg.add(req.body || {});
    res.status(201).json({ servers: reg.describe() });
  });
  admin.put('/servers/:slot', (req, res) => {
    reg.update(slotParam(req), req.body || {});
    res.json({ servers: reg.describe() });
  });
  admin.delete('/servers/:slot', (req, res) => {
    reg.remove(slotParam(req));
    res.json({ servers: reg.describe() });
  });
  admin.post('/servers/:slot/refresh', wrap(async (req, res) => {
    const slot = slotParam(req);
    if (!reg.get(slot)) throw new HttpError(404, 'Server not found or disabled');
    await catalogue.loadServer(slot);
    res.json(catalogue.stats());
  }));
  admin.get('/servers/:slot/users', wrap(async (req, res) => res.json({ users: await reg.jellyfinUsers(slotParam(req)) })));

  // -- users
  const userView = (u) => ({ ...u, mappings: users.mappings(u.id), sessions: users.sessionCount(u.id) });
  admin.get('/users', (req, res) => res.json({ users: users.list().map(userView) }));
  admin.post('/users', wrap(async (req, res) => {
    res.status(201).json(userView(await users.create(req.body || {})));
  }));
  admin.put('/users/:id', (req, res) => {
    const id = idParam(req);
    const { displayName, role, disabled } = req.body || {};
    if (id === req.user.id && (disabled || (role && role !== req.user.role))) throw new HttpError(409, 'You cannot disable or demote your own account');
    res.json(userView(users.update(id, { displayName, role, disabled })));
  });
  admin.post('/users/:id/password', wrap(async (req, res) => {
    const id = idParam(req);
    await users.setPassword(id, req.body?.password);
    users.revokeAll(id, id === req.user.id ? req.sessionToken : undefined);
    res.status(204).end();
  }));
  admin.delete('/users/:id', (req, res) => {
    const id = idParam(req);
    if (id === req.user.id) throw new HttpError(409, 'You cannot delete your own account');
    users.delete(id);
    res.status(204).end();
  });
  admin.delete('/users/:id/sessions', (req, res) => {
    users.revokeAll(idParam(req), idParam(req) === req.user.id ? req.sessionToken : undefined);
    res.status(204).end();
  });
  admin.put('/users/:id/mappings', (req, res) => {
    const id = idParam(req);
    const m = req.body?.mappings;
    if (!m || typeof m !== 'object') throw new HttpError(400, 'Send {"mappings": {"<slot>": "<jellyfin user id>" | null}}');
    for (const [slot, jf] of Object.entries(m)) {
      if (!reg.rows().some((r) => r.slot === Number(slot))) throw new HttpError(400, `Unknown server ${slot}`);
      users.setMapping(id, Number(slot), jf || null);
    }
    res.json(userView(users.get(id)));
  });
  // Convenience: link a user to the Jellyfin account with the same name on each server.
  admin.post('/users/:id/automatch', wrap(async (req, res) => {
    const id = idParam(req);
    const user = users.get(id);
    if (!user) throw new HttpError(404, 'User not found');
    const results = [];
    for (const srv of reg.list()) {
      try {
        const match = (await srv.users()).find((u) => u.name.toLowerCase() === user.username.toLowerCase() && !u.isDisabled);
        if (match) users.setMapping(id, srv.index, match.id);
        results.push({ slot: srv.index, server: srv.name, matched: match?.name ?? null });
      } catch (err) {
        results.push({ slot: srv.index, server: srv.name, matched: null, error: err.status === 403 ? 'credentials cannot list users' : err.message });
      }
    }
    res.json({ results, user: userView(users.get(id)) });
  }));

  admin.get('/stats', (req, res) => {
    res.json({
      catalogue: catalogue.stats(),
      users: users.count(),
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
    });
  });

  api.use('/admin', admin);
  app.use('/api', api);

  // Video and artwork need a session too (the browser sends the cookie automatically).
  app.use(['/proxy', '/api/img'], requireAuth);
  mountImages(app, reg);
  mountProxy(app, reg);

  // =========================================================== front end
  const hasGz = fs.existsSync(hlsGzFile);
  app.get('/vendor/hls.min.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=604800');
    if (hasGz && /\bgzip\b/.test(req.get('accept-encoding') || '')) {
      res.set({ 'Content-Encoding': 'gzip', 'Content-Type': 'text/javascript; charset=utf-8', Vary: 'Accept-Encoding' });
      return res.sendFile(hlsGzFile);
    }
    res.sendFile(hlsFile);
  });
  // No runtime compression (wasted CPU on a Pi); files are small and cached with ETags.
  app.use(express.static(publicDir, { maxAge: '1h' }));

  // ---- errors
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err instanceof HttpError ? err.status : err instanceof UpstreamError ? (err.network ? 503 : 502) : err.status || 500;
    if (status >= 500) console.warn(`[${req.method} ${req.path}] ${err.message}`);
    const safe = err instanceof HttpError || err instanceof UpstreamError || (status >= 400 && status < 500);
    res.status(status).json({ error: safe ? err.message : 'Internal error' });
  });

  const timers = [];
  /** Begin health monitoring, library loading and housekeeping. */
  function start() {
    reg.startMonitors();
    catalogue.start();
    users.cleanup();
    const t = setInterval(() => users.cleanup(), 3_600_000);
    t.unref();
    timers.push(t);
  }
  function stop() {
    reg.stopMonitors();
    catalogue.stop();
    clearInterval(limiter.timer);
    timers.forEach(clearInterval);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  return { app, db, settings, reg, users, catalogue, playback, start, stop, getSetupCode: () => setupCode };
}
