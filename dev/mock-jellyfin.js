/**
 * A tiny fake Jellyfin server, used by `npm run demo` and by the tests.
 *
 * It implements only the endpoints r_flix calls, with Jellyfin's response
 * shapes, plus generated artwork and (when ffmpeg is installed) a real test
 * video served both as direct play and as HLS. It is dev tooling — nothing in
 * src/ depends on it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = path.join(here, '.media');

export const hexId = (seed) => crypto.createHash('md5').update(seed).digest('hex');

/** Create sample.mp4 and an HLS rendition of it once, if ffmpeg is available. */
export function ensureSampleMedia() {
  const mp4 = path.join(MEDIA_DIR, 'sample.mp4');
  const hls = path.join(MEDIA_DIR, 'hls');
  if (fs.existsSync(mp4) && fs.existsSync(path.join(hls, 'main.m3u8'))) return true;
  try {
    fs.mkdirSync(hls, { recursive: true });
    const q = { stdio: 'ignore' };
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', mp4], q);
    execFileSync('ffmpeg', ['-y', '-i', mp4, '-c', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(hls, '%d.ts'), path.join(hls, 'main.m3u8')], q);
    return true;
  } catch {
    return false;
  }
}

const colour = (s) => `hsl(${parseInt(hexId(s).slice(0, 4), 16) % 360} 55% 32%)`;
const svg = (w, h, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="${colour(title)}"/><stop offset="1" stop-color="#111"/></linearGradient></defs>` +
  `<rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.round(h / 12)}" text-anchor="middle">${title.replace(/[<&]/g, '')}</text></svg>`;

/**
 * @param {object} o
 * @param {string} o.name        server name
 * @param {string} o.apiKey      accepted API key
 * @param {{user:string,pass:string}} [o.login]  also accept this username/password
 * @param {object[]} o.titles    [{ type:'Movie'|'Series', name, year, tmdb, imdb, genres, overview, transcode?, added }]
 * @param {Record<string,{pos?:number,played?:boolean}>} [o.watch] initial watch state keyed by title name or "name S1E2"
 */
export function createMockJellyfin(o) {
  const hasMedia = ensureSampleMedia();
  const userId = hexId(`${o.name}-user`);
  const loginToken = hexId(`${o.name}-token`);
  const items = new Map(); // id -> item (BaseItemDto-ish)
  const userData = new Map(); // id -> { PlaybackPositionTicks, Played, LastPlayedDate }
  const reports = []; // every playback report received (for assertions)
  const stats = { requests: 0 };

  let n = 0;
  const RUNTIME = 60 * 1e7;
  for (const t of o.titles) {
    const id = hexId(`${o.name}:${t.type}:${t.name}`);
    items.set(id, {
      Id: id, Type: t.type, Name: t.name, SortName: t.name.toLowerCase(), ProductionYear: t.year, Overview: t.overview || `${t.name} — a sample ${t.type.toLowerCase()}.`,
      Genres: t.genres || [], CommunityRating: t.rating ?? 7 + (n % 3) * 0.7, OfficialRating: 'PG-13', RunTimeTicks: t.type === 'Movie' ? RUNTIME : undefined,
      DateCreated: new Date(Date.now() - (t.added ?? n) * 86_400_000).toISOString(),
      ProviderIds: { ...(t.tmdb && { Tmdb: String(t.tmdb) }), ...(t.imdb && { Imdb: t.imdb }) },
      ImageTags: { Primary: 'p' }, BackdropImageTags: ['b'], transcode: !!t.transcode,
    });
    if (t.type === 'Series') {
      for (let s = 1; s <= (t.seasons || 2); s++) {
        for (let e = 1; e <= (t.episodes || 4); e++) {
          const eid = hexId(`${id}:S${s}E${e}`);
          items.set(eid, {
            Id: eid, Type: 'Episode', Name: `Episode ${e}`, SeriesId: id, SeriesName: t.name, ParentIndexNumber: s, IndexNumber: e,
            Overview: `Season ${s}, episode ${e} of ${t.name}.`, RunTimeTicks: RUNTIME, DateCreated: new Date().toISOString(), ProviderIds: {}, ImageTags: { Primary: 'p' },
            transcode: !!t.transcode,
          });
        }
      }
    }
    n++;
  }
  const byName = (name) => [...items.values()].find((i) => i.Name === name && i.Type !== 'Episode');
  const episodeOf = (series, s, e) => [...items.values()].find((i) => i.SeriesName === series && i.ParentIndexNumber === s && i.IndexNumber === e);
  for (const [key, w] of Object.entries(o.watch || {})) {
    const m = /^(.*) S(\d+)E(\d+)$/.exec(key);
    const it = m ? episodeOf(m[1], +m[2], +m[3]) : byName(key);
    if (it) userData.set(it.Id, { PlaybackPositionTicks: (w.pos || 0) * 1e7, Played: !!w.played, LastPlayedDate: new Date(Date.now() - (w.agoMin ?? 5) * 60_000).toISOString() });
  }

  const dto = (it) => {
    const ud = userData.get(it.Id) || {};
    const { transcode, ...rest } = it; // eslint-disable-line no-unused-vars
    return { ...rest, UserData: { Played: !!ud.Played, PlaybackPositionTicks: ud.PlaybackPositionTicks || 0, LastPlayedDate: ud.LastPlayedDate, UnplayedItemCount: 0 } };
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    stats.requests++;
    if (app.locals.down) return req.socket.destroy(); // simulate a dead server
    next();
  });

  app.get('/System/Info/Public', (req, res) => res.json({ ServerName: o.name, Version: '10.9.99-mock', Id: userId }));

  app.post('/Users/AuthenticateByName', (req, res) => {
    if (o.login && req.body.Username === o.login.user && req.body.Pw === o.login.pass) {
      return res.json({ AccessToken: loginToken, User: { Id: userId, Name: o.login.user } });
    }
    res.status(401).end();
  });

  // ---- auth guard
  app.use((req, res, next) => {
    const h = req.get('authorization') || '';
    const token = req.get('x-emby-token') || /Token="([^"]+)"/.exec(h)?.[1] || req.query.api_key;
    if (token && (token === o.apiKey || token === loginToken)) return next();
    res.status(401).end();
  });
  app.use((req, res, next) => { // so tests can assert the browser never supplied credentials
    app.locals.lastAuthQuery = req.query.api_key;
    next();
  });

  app.get('/Users', (req, res) => res.json([{ Id: userId, Name: 'demo', Policy: { IsAdministrator: true, IsDisabled: false } }]));

  app.get('/Items', (req, res) => {
    let list = [...items.values()];
    if (req.query.Ids) {
      const ids = String(req.query.Ids).split(',');
      list = list.filter((i) => ids.includes(i.Id));
    } else {
      const types = String(req.query.IncludeItemTypes || '').split(',');
      list = list.filter((i) => types.includes(i.Type));
      list.sort((a, b) => b.DateCreated.localeCompare(a.DateCreated));
    }
    const start = Number(req.query.StartIndex) || 0;
    const limit = Number(req.query.Limit) || list.length;
    const withPeople = String(req.query.Fields || '').includes('People');
    res.json({
      Items: list.slice(start, start + limit).map((i) => ({
        ...dto(i),
        ...(withPeople && { People: [{ Name: 'Ada Example', Type: 'Actor', Role: 'Lead' }, { Name: 'Dan Director', Type: 'Director' }], Taglines: ['A sample tagline'] }),
      })),
      TotalRecordCount: list.length,
    });
  });

  const resume = (req, res) => {
    const list = [...items.values()]
      .filter((i) => ['Movie', 'Episode'].includes(i.Type) && userData.get(i.Id)?.PlaybackPositionTicks > 0 && !userData.get(i.Id).Played)
      .sort((a, b) => userData.get(b.Id).LastPlayedDate.localeCompare(userData.get(a.Id).LastPlayedDate));
    res.json({ Items: list.map(dto), TotalRecordCount: list.length });
  };
  // `legacyOnly` mimics an older server that only has the /Users/{id}/... route.
  app.get('/UserItems/Resume', o.legacyOnly ? (req, res) => res.status(404).end() : resume);
  app.get(`/Users/${userId}/Items/Resume`, resume);

  app.get('/Shows/NextUp', (req, res) => {
    const out = [];
    for (const s of [...items.values()].filter((i) => i.Type === 'Series')) {
      const eps = [...items.values()].filter((i) => i.SeriesId === s.Id).sort((a, b) => a.ParentIndexNumber - b.ParentIndexNumber || a.IndexNumber - b.IndexNumber);
      const lastPlayed = eps.map((e, idx) => [e, idx]).filter(([e]) => userData.get(e.Id)?.Played).pop();
      if (lastPlayed && eps[lastPlayed[1] + 1] && !userData.get(eps[lastPlayed[1] + 1].Id)?.PlaybackPositionTicks) out.push(eps[lastPlayed[1] + 1]);
    }
    res.json({ Items: out.map(dto), TotalRecordCount: out.length });
  });

  app.get('/Shows/:id/Episodes', (req, res) => {
    const eps = [...items.values()].filter((i) => i.SeriesId === req.params.id);
    res.json({ Items: eps.map(dto), TotalRecordCount: eps.length });
  });

  app.post('/Items/:id/PlaybackInfo', (req, res) => {
    const it = items.get(req.params.id);
    if (!it) return res.status(404).end();
    const PlaySessionId = hexId(`${Date.now()}${Math.random()}`);
    // Like real Jellyfin: direct play unless the title needs transcoding or the client disabled it,
    // and a transcoding URL is always on offer as the fallback.
    const direct = !it.transcode && req.body?.EnableDirectPlay !== false;
    const ms = {
      Id: it.Id, Container: 'mp4', RunTimeTicks: it.RunTimeTicks, ETag: 'etag', SupportsDirectPlay: direct, SupportsDirectStream: direct, SupportsTranscoding: true,
      MediaStreams: [
        { Type: 'Video', Codec: 'h264', Index: 0 },
        { Type: 'Subtitle', Codec: 'subrip', Index: 2, IsTextSubtitleStream: true, DisplayTitle: 'English', Language: 'eng', IsDefault: false },
      ],
    };
    if (!direct) {
      ms.TranscodingUrl = `/videos/${it.Id}/master.m3u8?DeviceId=x&MediaSourceId=${it.Id}&PlaySessionId=${PlaySessionId}&api_key=${req.get('x-emby-token')}&VideoCodec=h264`;
      ms.TranscodingSubProtocol = 'hls';
    }
    res.json({ MediaSources: [ms], PlaySessionId });
  });

  const report = (kind) => (req, res) => {
    reports.push({ kind, ...req.body });
    res.status(204).end();
  };
  app.post('/Sessions/Playing', report('start'));
  app.post('/Sessions/Playing/Progress', report('progress'));
  app.post('/Sessions/Playing/Stopped', report('stopped'));
  app.delete('/Videos/ActiveEncodings', (req, res) => { reports.push({ kind: 'killTranscode', ...req.query }); res.status(204).end(); });

  const saveUserData = (req, res) => {
    const id = req.params.id;
    if (!items.has(id)) return res.status(404).end();
    userData.set(id, { ...(userData.get(id) || {}), ...req.body });
    res.status(204).end();
  };
  app.post('/UserItems/:id/UserData', saveUserData);
  app.post(`/Users/${userId}/Items/:id/UserData`, saveUserData);

  // ---- artwork: generated SVG; episodes have 16:9 stills, titles have portrait posters
  app.get('/Items/:id/Images/:kind', (req, res) => {
    const it = items.get(req.params.id);
    if (!it || req.params.kind === 'Logo') return res.status(404).end();
    if (req.params.kind === 'Backdrop' && it.Type === 'Episode') return res.status(404).end();
    const wide = req.params.kind === 'Backdrop' || it.Type === 'Episode';
    res.type('image/svg+xml').send(svg(wide ? 1280 : 400, wide ? 720 : 600, it.SeriesName ? `${it.SeriesName} ${it.IndexNumber}` : it.Name));
  });

  // ---- media (only when ffmpeg produced the sample files)
  const needMedia = (req, res, next) => (hasMedia ? next() : res.status(404).end());
  app.get('/Videos/:id/stream', needMedia, (req, res) => res.sendFile(path.join(MEDIA_DIR, 'sample.mp4'))); // sendFile handles Range
  const qs = (req) => req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  app.get('/videos/:id/master.m3u8', needMedia, (req, res) =>
    res.type('application/vnd.apple.mpegurl').send(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360\nmain.m3u8${qs(req)}\n`));
  app.get('/videos/:id/main.m3u8', needMedia, (req, res) => {
    const text = fs.readFileSync(path.join(MEDIA_DIR, 'hls', 'main.m3u8'), 'utf8').replace(/^(\d+\.ts)$/gm, `hls1/main/$1${qs(req)}`);
    res.type('application/vnd.apple.mpegurl').send(text);
  });
  app.get('/videos/:id/hls1/main/:seg', needMedia, (req, res) => res.sendFile(path.join(MEDIA_DIR, 'hls', path.basename(req.params.seg))));
  app.get('/Videos/:id/:ms/Subtitles/:idx/0/Stream.vtt', (req, res) =>
    res.type('text/vtt').send('WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nHello from the mock subtitles\n'));

  let httpServer;
  return {
    app, items, userData, reports, stats, userId, hasMedia,
    /** Listen on a port (0 = random). Resolves to the base URL. */
    start: (port = 0, host = '127.0.0.1') => new Promise((resolve) => {
      httpServer = app.listen(port, host, () => resolve(`http://${host}:${httpServer.address().port}`));
    }),
    stop: () => new Promise((resolve) => { httpServer?.closeAllConnections?.(); httpServer ? httpServer.close(resolve) : resolve(); }),
    /** Simulate an outage: every connection is dropped until setDown(false). */
    setDown: (down) => { app.locals.down = down; },
    byName, episodeOf,
  };
}
