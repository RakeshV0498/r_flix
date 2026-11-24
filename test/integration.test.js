import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootStack, findCard, waitFor } from './helpers.js';

let s, admin, a, b, base;
before(async () => {
  s = await bootStack();
  ({ admin, a, b, base } = s);
});
after(() => s.close());

const home = async (c = admin) => (await c.get('/api/home')).body;

test('merges both servers into one catalogue, duplicates shown once', async () => {
  const body = await home();
  const all = body.rows.find((r) => r.id === 'recent').items;
  assert.deepEqual(all.map((i) => i.title).sort(), ['Only On A', 'Only On B', 'Shared Film', 'Shared Show', 'Transcoded']);
  assert.deepEqual(findCard(body.rows, 'Shared Film').servers, ['Server A', 'Server B']);
});

test('API-key server and username/password server both work (incl. legacy resume route)', async () => {
  const st = (await admin.get('/api/status')).body.servers;
  assert.ok(st.every((x) => x.online && !x.authError));
  const cont = (await home()).rows.find((r) => r.id === 'continue');
  assert.equal(Math.round(cont.items[0].progress), 33); // 20s of 60s, from server A (shared default user)
});

test('status never leaks server addresses', async () => {
  const text = JSON.stringify((await admin.get('/api/status')).body);
  assert.ok(!/127\.0\.0\.1|:\d{4,5}/.test(text));
});

test('details, episodes (merged across servers) and search', async () => {
  const show = findCard((await home()).rows, 'Shared Show');
  const d = (await admin.get(`/api/items/${show.id}`)).body;
  assert.equal(d.cast[0].name, 'Ada Example');
  const eps = (await admin.get(`/api/items/${show.id}/episodes`)).body.seasons;
  assert.equal(eps.length, 2);
  assert.equal(eps[0].episodes.length, 4); // same S/E on both servers = one episode
  assert.equal((await admin.get('/api/search?q=only on')).body.items.length, 2);
  assert.equal((await admin.get('/api/items/not-a-uid')).status, 400);
});

test('direct play and HLS fallback URLs point at the proxy and carry no credentials', async () => {
  const rows = (await home()).rows;
  const direct = (await admin.get(`/api/play/${findCard(rows, 'Only On A').id}`)).body;
  assert.equal(direct.mode, 'direct');
  const hls = (await admin.get(`/api/play/${findCard(rows, 'Transcoded').id}`)).body;
  assert.equal(hls.mode, 'hls');
  for (const p of [direct, hls]) {
    assert.match(p.url, /^\/proxy\/\d\//);
    assert.ok(!/api_key|key-a/i.test(p.url), p.url);
  }
  if (a.hasMedia) {
    assert.equal((await admin.get(direct.url, { headers: { Range: 'bytes=0-9' } })).status, 206);
    assert.match((await admin.get(hls.url)).body, /^#EXTM3U/);
  }
});

test('resume merges across servers; progress is written to every reachable copy', async () => {
  const film = findCard((await home()).rows, 'Shared Film');
  const p = (await admin.get(`/api/play/${film.id}`)).body;
  assert.equal(p.startSeconds, 20); // watched on A only, resumes anywhere
  const rep = { uid: film.id, positionSeconds: 45, durationSeconds: 60, playSessionId: p.playSessionId, serverIndex: p.serverIndex, mediaSourceId: p.mediaSourceId, playMethod: 'DirectPlay' };
  assert.equal((await admin.post('/api/progress', { ...rep, event: 'progress' })).status, 204);
  const idA = a.byName('Shared Film').Id;
  const idB = b.byName('Shared Film').Id;
  assert.equal(a.ud(a.userId, idA).PlaybackPositionTicks, 45e7);
  assert.equal(b.ud(b.userId, idB).PlaybackPositionTicks, 45e7); // synced to the other server too
  assert.equal((await admin.post('/api/progress', { ...rep, event: 'stop', positionSeconds: 58 })).status, 204);
  assert.equal(a.ud(a.userId, idA).Played, true); // >= 90% => watched
  assert.equal(a.reports.at(-1).kind, 'stopped');
  assert.equal((await admin.post('/api/progress', { uid: film.id, event: 'nope', positionSeconds: 1, serverIndex: 0 })).status, 400);
});

test('proxy only serves allow-listed media paths and ignores client-supplied credentials', async () => {
  const id = a.byName('Only On A').Id;
  for (const p of ['/proxy/0/System/Info', '/proxy/0/Users', `/proxy/0/Videos/${id}/%2e%2e/Users`, `/proxy/0/Items/${id}/Images/Primary`]) {
    assert.equal((await admin.get(p)).status, 403, p);
  }
  assert.equal((await admin.get(`/proxy/7/Videos/${id}/stream`)).status, 404);
  if (a.hasMedia) {
    await admin.get(`/proxy/0/Videos/${id}/stream?api_key=EVIL`, { headers: { Range: 'bytes=0-1' } });
    assert.notEqual(a.app.locals.lastAuthQuery, 'EVIL');
  }
});

test('images are proxied', async () => {
  const film = findCard((await home()).rows, 'Only On B');
  const r = await admin.get(`/api/img/${film.id}/Primary?w=200`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image/);
  assert.equal((await admin.get(`/api/img/${film.id}/Logo`)).status, 404);
});

test('server B outage: status flips, catalogue keeps working, playback fails over', async () => {
  const rows = (await home()).rows;
  const shared = findCard(rows, 'Shared Film');
  const onlyB = findCard(rows, 'Only On B');

  b.setDown(true);
  await waitFor(async () => (await admin.get('/api/status')).body.servers[1].online === false);

  const after = await home();
  assert.equal(after.rows.find((r) => r.id === 'recent').items.length, 5); // nothing vanished
  assert.equal(findCard(after.rows, 'Only On B').available, false); // but flagged
  assert.equal(findCard(after.rows, 'Shared Film').available, true);
  assert.equal((await admin.get(`/api/play/${shared.id}`)).body.serverIndex, 0); // served from A
  assert.equal((await admin.get(`/api/play/${onlyB.id}`)).status, 503);

  b.setDown(false);
  await waitFor(async () => (await admin.get('/api/status')).body.servers[1].online === true);
  assert.equal(findCard((await home()).rows, 'Only On B').available, true);
});

test('player-requested failover: excluding a server plays from the other copy', async () => {
  const shared = findCard((await home()).rows, 'Shared Film');
  const p = (await admin.get(`/api/play/${shared.id}?exclude=0&start=33`)).body;
  assert.equal(p.serverIndex, 1);
  assert.equal(p.startSeconds, 33);
  assert.equal((await admin.get(`/api/play/${shared.id}?exclude=0,1`)).status, 503);
});

test('both servers down: API reports it cleanly instead of crashing', async () => {
  a.setDown(true);
  b.setDown(true);
  await waitFor(async () => (await admin.get('/api/status')).body.servers.every((x) => !x.online));
  const r = await admin.get('/api/home');
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.length > 0); // cached catalogue still served
  a.setDown(false);
  b.setDown(false);
  await waitFor(async () => (await admin.get('/api/status')).body.servers.every((x) => x.online));
});
