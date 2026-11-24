import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockJellyfin } from '../dev/mock-jellyfin.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// Server A: API key. Server B: username/password login. They share some titles.
const T = (type, name, tmdb, extra = {}) => ({ type, name, year: 2020, tmdb, genres: ['Drama'], ...extra });
const A_TITLES = [T('Movie', 'Shared Film', 1), T('Movie', 'Only On A', 2), T('Series', 'Shared Show', 10), T('Movie', 'Transcoded', 3, { transcode: true })];
const B_TITLES = [T('Movie', 'Shared Film', 1), T('Movie', 'Only On B', 4), T('Series', 'Shared Show', 10)];

let a, b, ctx, httpServer, base;
const get = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text(), headers: r.headers }; };
const findCard = (rows, title) => rows.flatMap((r) => r.items).find((i) => i.title === title);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await wait(50); } throw new Error('timeout waiting for condition'); };

before(async () => {
  a = createMockJellyfin({ name: 'A', apiKey: 'key-a', titles: A_TITLES, watch: { 'Shared Film': { pos: 20, agoMin: 10 } } });
  b = createMockJellyfin({ name: 'B', apiKey: 'unused', login: { user: 'bob', pass: 'pw' }, titles: B_TITLES, legacyOnly: true });
  const [ua, ub] = [await a.start(), await b.start()];
  const cfg = loadConfig({
    RFLIX_CONFIG: '/nonexistent', PORT: '0',
    JELLYFIN_1_URL: ua, JELLYFIN_1_API_KEY: 'key-a', JELLYFIN_1_NAME: 'Server A',
    JELLYFIN_2_URL: ub, JELLYFIN_2_USERNAME: 'bob', JELLYFIN_2_PASSWORD: 'pw', JELLYFIN_2_NAME: 'Server B',
  });
  cfg.healthIntervalSeconds = 0.2;
  cfg.requestTimeoutMs = 1500;
  ctx = createApp(cfg);
  ctx.start();
  httpServer = await new Promise((res) => { const s = ctx.app.listen(0, '127.0.0.1', () => res(s)); });
  base = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  ctx.stop();
  httpServer.closeAllConnections();
  httpServer.close();
  await Promise.all([a.stop(), b.stop()]);
});

test('merges both servers into one catalogue, duplicates shown once', async () => {
  const { body } = await get('/api/home');
  const all = body.rows.find((r) => r.id === 'recent').items;
  assert.deepEqual(all.map((i) => i.title).sort(), ['Only On A', 'Only On B', 'Shared Film', 'Shared Show', 'Transcoded']);
  assert.deepEqual(findCard(body.rows, 'Shared Film').servers, ['Server A', 'Server B']);
});

test('works with both an API key and a username/password login, incl. legacy resume route', async () => {
  const st = (await get('/api/status')).body.servers;
  assert.ok(st.every((s) => s.online && !s.authError));
  const cont = (await get('/api/home')).body.rows.find((r) => r.id === 'continue');
  assert.equal(Math.round(cont.items[0].progress), 33); // 20s of 60s, from server A
});

test('status never leaks server addresses', async () => {
  const text = JSON.stringify((await get('/api/status')).body);
  assert.ok(!/127\.0\.0\.1|:\d{4,5}/.test(text.replace(/"latencyMs":\d+/, '')));
});

test('details, episodes (merged across servers) and search', async () => {
  const home = (await get('/api/home')).body;
  const show = findCard(home.rows, 'Shared Show');
  const d = (await get(`/api/items/${show.id}`)).body;
  assert.equal(d.cast[0].name, 'Ada Example');
  const eps = (await get(`/api/items/${show.id}/episodes`)).body.seasons;
  assert.equal(eps.length, 2);
  assert.equal(eps[0].episodes.length, 4); // 4 episodes, not 8: same S/E on both servers = one episode
  assert.equal((await get('/api/search?q=only on')).body.items.length, 2);
  assert.equal((await get('/api/items/not-a-uid')).status, 400);
});

test('direct play and HLS fallback URLs point at the proxy and carry no credentials', async () => {
  const home = (await get('/api/home')).body;
  const direct = (await get(`/api/play/${findCard(home.rows, 'Only On A').id}`)).body;
  assert.equal(direct.mode, 'direct');
  const hls = (await get(`/api/play/${findCard(home.rows, 'Transcoded').id}`)).body;
  assert.equal(hls.mode, 'hls');
  for (const p of [direct, hls]) {
    assert.match(p.url, /^\/proxy\/0\//);
    assert.ok(!/api_key|key-a/i.test(p.url), p.url);
  }
  if (a.hasMedia) {
    const r = await fetch(base + direct.url, { headers: { Range: 'bytes=0-9' } });
    assert.equal(r.status, 206);
    const m3u8 = await (await fetch(base + hls.url)).text();
    assert.match(m3u8, /^#EXTM3U/);
  }
});

test('resume position merges across servers; progress is written to every reachable copy', async () => {
  const home = (await get('/api/home')).body;
  const film = findCard(home.rows, 'Shared Film');
  const p = (await get(`/api/play/${film.id}`)).body;
  assert.equal(p.startSeconds, 20); // watched on A only, resumes anywhere
  const post = (body) => get('/api/progress', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const rep = { uid: film.id, positionSeconds: 45, durationSeconds: 60, playSessionId: p.playSessionId, serverIndex: p.serverIndex, mediaSourceId: p.mediaSourceId, playMethod: 'DirectPlay' };
  assert.equal((await post({ ...rep, event: 'progress' })).status, 204);
  const idA = a.byName('Shared Film').Id, idB = b.byName('Shared Film').Id;
  assert.equal(a.userData.get(idA).PlaybackPositionTicks, 45e7);
  assert.equal(b.userData.get(idB).PlaybackPositionTicks, 45e7); // synced to the other server too (via its legacy route)
  assert.equal((await post({ ...rep, event: 'stop', positionSeconds: 58 })).status, 204);
  assert.equal(a.userData.get(idA).Played, true); // >= 90% => watched
  assert.equal(a.reports.at(-1).kind, 'stopped');
  assert.equal((await post({ uid: film.id, event: 'nope', positionSeconds: 1, serverIndex: 0 })).status, 400);
});

test('proxy only serves allow-listed media paths and ignores client-supplied credentials', async () => {
  const id = a.byName('Only On A').Id;
  for (const p of ['/proxy/0/System/Info', '/proxy/0/Users', `/proxy/0/Videos/${id}/%2e%2e/Users`, `/proxy/0/Items/${id}/Images/Primary`]) {
    assert.equal((await get(p)).status, 403, p);
  }
  assert.equal((await get(`/proxy/7/Videos/${id}/stream`)).status, 404);
  if (a.hasMedia) {
    await get(`/proxy/0/Videos/${id}/stream?api_key=EVIL`, { headers: { Range: 'bytes=0-1' } });
    assert.notEqual(a.app.locals.lastAuthQuery, 'EVIL');
  }
});

test('images are proxied', async () => {
  const film = findCard((await get('/api/home')).body.rows, 'Only On B');
  const r = await get(`/api/img/${film.id}/Primary?w=200`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image/);
  assert.equal((await get(`/api/img/${film.id}/Logo`)).status, 404);
});

test('server B outage: status flips, catalogue keeps working, playback fails over', async () => {
  const home = (await get('/api/home')).body;
  const shared = findCard(home.rows, 'Shared Film');
  const onlyB = findCard(home.rows, 'Only On B');

  b.setDown(true);
  await waitFor(async () => (await get('/api/status')).body.servers[1].online === false);

  const after = (await get('/api/home')).body;
  assert.equal(after.rows.find((r) => r.id === 'recent').items.length, 5); // nothing vanished
  assert.equal(findCard(after.rows, 'Only On B').available, false); // but flagged
  assert.equal(findCard(after.rows, 'Shared Film').available, true);
  assert.equal((await get(`/api/play/${shared.id}`)).body.serverIndex, 0); // served from A
  assert.equal((await get(`/api/play/${onlyB.id}`)).status, 503);

  b.setDown(false);
  await waitFor(async () => (await get('/api/status')).body.servers[1].online === true);
  assert.equal(findCard((await get('/api/home')).body.rows, 'Only On B').available, true);
});

test('player-requested failover: excluding a server plays from the other copy', async () => {
  const shared = findCard((await get('/api/home')).body.rows, 'Shared Film');
  const p = (await get(`/api/play/${shared.id}?exclude=0&start=33`)).body;
  assert.equal(p.serverIndex, 1);
  assert.equal(p.startSeconds, 33);
  assert.equal((await get(`/api/play/${shared.id}?exclude=0,1`)).status, 503);
});

test('both servers down: API reports it cleanly instead of crashing', async () => {
  a.setDown(true); b.setDown(true);
  await waitFor(async () => (await get('/api/status')).body.servers.every((s) => !s.online));
  const home = await get('/api/home');
  assert.equal(home.status, 200);
  assert.ok(home.body.rows.length > 0); // cached catalogue still served
  a.setDown(false); b.setDown(false);
  await waitFor(async () => (await get('/api/status')).body.servers.every((s) => s.online));
});
