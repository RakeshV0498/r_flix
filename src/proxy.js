/**
 * Streaming proxy: the browser talks only to r_flix, never to a Jellyfin server.
 *
 *   /proxy/<server>/<jellyfin path>   video, HLS playlists/segments, subtitles
 *   /api/img/<uid>/<kind>             artwork (with fallback between servers)
 *
 * /proxy forwards ONLY an allow-list of media paths. Without that, anyone who
 * can reach r_flix could use its (possibly admin) API key against the whole
 * Jellyfin API. Authentication is added here, server-side; any credentials in
 * the incoming query string are discarded.
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decodeUid } from './ids.js';
import { HttpError } from './http-error.js';

const ID = '[0-9a-f]{32}';
const ALLOWED = [
  // direct play / progressive: /Videos/<id>/stream[.ext]
  new RegExp(`^/Videos/${ID}/stream(\\.\\w{1,5})?$`, 'i'),
  // HLS: master/main playlists and segments
  new RegExp(`^/Videos/${ID}/(master|main|live)\\.m3u8$`, 'i'),
  new RegExp(`^/Videos/${ID}/hls1?/[\\w.-]+/[\\w.-]+$`, 'i'),
  // text subtitles converted to WebVTT by Jellyfin
  new RegExp(`^/Videos/${ID}/[\\w-]{1,64}/Subtitles/\\d{1,3}/\\d{1,2}/Stream\\.(vtt|srt)$`, 'i'),
];

const FORWARD_REQ = ['range', 'if-range', 'if-none-match', 'if-modified-since'];
const FORWARD_RES = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];
const SECRET_PARAM = /^(api_key|apikey|x-emby-token|token)$/i;

/** Abort the upstream request when the browser goes away (stops needless transcoding/bandwidth). */
function abortOnClose(res) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  return ac.signal;
}

/** Copy a fetch() Response to an Express response as a stream. */
async function pipeBody(upstream, res) {
  if (!upstream.body) return res.end();
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    /* client went away mid-stream; nothing to do */
  }
}

/**
 * HLS playlists are small text files. Rewrite any absolute URL (which would
 * leak the server address) so it points back at the proxy, and scrub tokens.
 */
export function rewritePlaylist(text, serverIndex, upstreamBase) {
  const prefix = `/proxy/${serverIndex}`;
  const toProxy = (u) => {
    if (/^https?:\/\//i.test(u)) {
      const { pathname, search } = new URL(u);
      const basePath = new URL(upstreamBase).pathname.replace(/\/$/, '');
      return `${prefix}${basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname}${search}`;
    }
    return u.startsWith('/') ? prefix + u : u; // relative URLs already resolve inside the proxy
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${toProxy(u)}"`);
      return toProxy(line.trim());
    })
    .join('\n')
    .replace(/\?(?:api_key|apikey)=[^&\s"]*&/gi, '?')
    .replace(/[?&](?:api_key|apikey)=[^&\s"]*/gi, '');
}

/** @param {import('./servers.js').ServerRegistry} reg  (callers must have authenticated the request) */
export function mountProxy(app, reg) {
  app.get('/proxy/:server(\\d)/*', async (req, res, next) => {
    try {
      const srv = reg.get(Number(req.params.server));
      if (!srv) throw new HttpError(404, 'Unknown server');
      // Use the raw (still-encoded) path so "%2e%2e/" tricks can't sneak past the allow-list.
      const pathname = req.path.slice(`/proxy/${req.params.server}`.length);
      if (/[%\\]|\.\.|\/\//.test(pathname) || !ALLOWED.some((re) => re.test(pathname))) throw new HttpError(403, 'Path not allowed');
      if (srv.online === false) throw new HttpError(503, `${srv.name} is offline`);

      const query = new URLSearchParams(req.url.split('?')[1] || '');
      for (const k of [...query.keys()]) if (SECRET_PARAM.test(k)) query.delete(k);

      const headers = { Accept: '*/*' };
      for (const h of FORWARD_REQ) if (req.headers[h]) headers[h] = req.headers[h];

      const { res: up } = await srv.raw(pathname, { query: query.toString(), headers, method: req.method, signal: abortOnClose(res) });

      res.status(up.status === 401 || up.status === 403 ? 502 : up.status);
      const isPlaylist = /mpegurl/i.test(up.headers.get('content-type') || '') || /\.m3u8$/i.test(pathname);
      if (isPlaylist && up.ok) {
        const text = rewritePlaylist(await up.text(), srv.index, srv.base);
        res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
        return res.send(text);
      }
      for (const h of FORWARD_RES) if (up.headers.has(h)) res.set(h, up.headers.get(h));
      await pipeBody(up, res);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      next(err);
    }
  });
}

const IMAGE_KINDS = {
  Primary: ['Primary'],
  Backdrop: ['Backdrop'],
  Logo: ['Logo'],
  // wide artwork: a movie/series backdrop, or an episode's still (its Primary image)
  Landscape: ['Backdrop', 'Primary'],
};

/** At most `max` image fetches at once: a home page asks for dozens of posters in one go. */
function limiter(max) {
  let active = 0;
  const waiting = [];
  return async () => {
    if (active >= max) await new Promise((r) => waiting.push(r));
    else active++;
    // A waiter inherits the slot of whoever released, so `active` stays accurate.
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = waiting.shift();
      if (next) next();
      else active--;
    };
  };
}

export function mountImages(app, reg) {
  const acquire = limiter(6);
  app.get('/api/img/:uid/:kind', async (req, res, next) => {
    try {
      const variants = decodeUid(req.params.uid);
      const kinds = IMAGE_KINDS[req.params.kind];
      if (!variants || !kinds) throw new HttpError(400, 'Bad image request');
      const width = Math.min(1920, Math.max(60, Number(req.query.w) || 400));
      const signal = abortOnClose(res);
      const release = await acquire();
      if (signal.aborted) return release(); // browser left while we queued
      res.on('close', release); // free the slot when this response ends or the browser leaves

      for (const kind of kinds) {
        for (const v of variants) {
          const srv = reg.get(v.s);
          if (!srv || srv.online === false) continue;
          try {
            const { res: up } = await srv.raw(`/Items/${v.id}/Images/${kind}`, { query: { maxWidth: width, quality: 85 }, signal, headers: { Accept: 'image/*' } });
            if (!up.ok) {
              await up.body?.cancel().catch(() => {});
              continue; // this server has no such image: try the next copy
            }
            res.set({ 'Content-Type': up.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
            if (up.headers.has('content-length')) res.set('Content-Length', up.headers.get('content-length'));
            return await pipeBody(up, res);
          } catch {
            /* server unreachable: fall through to the next copy */
          }
        }
      }
      res.status(404).end();
    } catch (err) {
      next(err);
    }
  });
}
