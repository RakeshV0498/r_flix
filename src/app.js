/**
 * Express application: JSON API, proxy routes and the static front end.
 * Kept separate from server.js so tests can build an app without listening.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Catalogue } from './catalogue.js';
import { JellyfinServer, UpstreamError } from './jellyfin.js';
import { Playback } from './playback.js';
import { mountProxy, mountImages } from './proxy.js';
import { decodeUid } from './ids.js';
import { HttpError } from './http-error.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const hlsFile = path.join(here, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js');
// The Docker build gzips hls.js once, so the Pi never spends CPU compressing it per request.
const hlsGzFile = `${hlsFile}.gz`;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Build servers + catalogue + express app from a loaded config. */
export function createApp(cfg) {
  const servers = cfg.servers.map((s, i) => new JellyfinServer(s, i, { timeoutMs: cfg.requestTimeoutMs }));
  const catalogue = new Catalogue(servers, cfg);
  const playback = new Playback(servers, catalogue, cfg);

  const app = express();
  app.disable('x-powered-by');

  // Everything the page needs comes from this origin (hls.js runs its worker from a blob:).
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  // ---- status / health
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      servers: servers.map((s) => ({
        index: s.index,
        name: s.name,
        online: s.online !== false, // unknown (still checking) shows as up until proven otherwise
        checking: s.online === null,
        authError: s.authError,
        latencyMs: s.latencyMs,
        version: s.info?.version || null,
        items: catalogue.libs.get(s.index)?.items.length ?? 0,
        // Deliberately no address or raw error text: the browser never learns where servers live.
      })),
    });
  });

  // ---- catalogue
  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/home', wrap(async (req, res) => res.json(await catalogue.home())));

  api.get('/browse', wrap(async (req, res) => {
    await catalogue.ensureLoaded();
    const type = { Movie: 'Movie', Series: 'Series' }[req.query.type];
    res.json(
      catalogue.browse({
        type,
        genre: req.query.genre ? String(req.query.genre) : undefined,
        sort: String(req.query.sort || 'added'),
        offset: Math.max(0, Number(req.query.offset) || 0),
        limit: Math.min(120, Math.max(1, Number(req.query.limit) || 60)),
      }),
    );
  }));

  api.get('/search', wrap(async (req, res) => {
    await catalogue.ensureLoaded();
    res.json({ items: catalogue.search(String(req.query.q || '').slice(0, 100)) });
  }));

  api.get('/items/:uid', wrap(async (req, res) => {
    if (!decodeUid(req.params.uid)) throw new HttpError(400, 'Bad item id');
    await catalogue.ensureLoaded();
    const d = await catalogue.details(req.params.uid);
    if (!d) throw new HttpError(404, 'Title not found');
    res.json(d);
  }));

  api.get('/items/:uid/episodes', wrap(async (req, res) => {
    await catalogue.ensureLoaded();
    const group = catalogue.groupFor(req.params.uid);
    if (!group || group.type !== 'Series') throw new HttpError(404, 'Series not found');
    res.json({ seasons: (await catalogue.episodesOf(group)).seasons });
  }));

  // ---- playback
  api.get('/play/:uid', wrap(async (req, res) => {
    const exclude = new Set(String(req.query.exclude || '').split(',').filter(Boolean).map(Number));
    const start = req.query.start !== undefined ? Number(req.query.start) : undefined;
    res.json(await playback.prepare(req.params.uid, { exclude, start, forceTranscode: req.query.transcode === '1' }));
  }));

  api.post('/progress', express.json({ limit: '8kb' }), wrap(async (req, res) => {
    const b = req.body || {};
    const ok =
      typeof b.uid === 'string' &&
      ['start', 'progress', 'stop'].includes(b.event) &&
      Number.isFinite(b.positionSeconds) && b.positionSeconds >= 0 && b.positionSeconds < 1e6 &&
      Number.isInteger(b.serverIndex);
    if (!ok) throw new HttpError(400, 'Bad playback report');
    await playback.report({
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

  app.use('/api', api);
  mountImages(app, servers);
  mountProxy(app, servers);

  // ---- front end
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
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError || err instanceof UpstreamError) ? 'Internal error' : err.message });
  });

  /** Begin health monitoring and library loading. */
  function start() {
    for (const s of servers) s.startMonitor(cfg.healthIntervalSeconds * 1000);
    catalogue.start();
  }
  function stop() {
    for (const s of servers) s.stopMonitor();
    clearInterval(catalogue.timer);
  }
  return { app, servers, catalogue, playback, start, stop };
}
