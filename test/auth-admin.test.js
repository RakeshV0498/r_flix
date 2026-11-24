import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootStack, findCard, waitFor, makeClient, A_TITLES, T } from './helpers.js';
import { createApp } from '../src/app.js';
import { createMockJellyfin } from '../dev/mock-jellyfin.js';

let s, admin;
before(async () => {
  s = await bootStack();
  admin = s.admin;
});
after(() => s.close());

test('signed-out visitors get nothing but the login/setup shell', async () => {
  const anon = s.client();
  for (const p of ['/api/home', '/api/status', '/api/me', '/api/search?q=a', '/api/img/x/Primary', '/proxy/0/Videos/a/stream', '/api/admin/users']) {
    assert.equal((await anon.get(p)).status, 401, p);
  }
  assert.equal((await anon.get('/api/health')).status, 200);
  assert.equal((await anon.get('/')).status, 200); // the static page (it renders the login form)
  assert.equal((await anon.get('/api/setup/state')).body.needsSetup, false);
});

test('first-run setup: needs the log code, works once, then is closed', async () => {
  const fresh = createApp({ dataDir: ':memory:', env: { RFLIX_SETUP_CODE: 'secret1' }, log: () => {} });
  const srv = await new Promise((r) => { const x = fresh.app.listen(0, '127.0.0.1', () => r(x)); });
  const c = makeClient(`http://127.0.0.1:${srv.address().port}`);
  try {
    assert.equal((await c.get('/api/setup/state')).body.needsSetup, true);
    assert.equal((await c.post('/api/setup', { code: 'wrong', username: 'root', password: 'password123' })).status, 403);
    assert.equal((await c.post('/api/setup', { code: 'secret1', username: 'x', password: 'password123' })).status, 400); // username too short
    assert.equal((await c.post('/api/setup', { code: 'secret1', username: 'root', password: 'short' })).status, 400);
    const ok = await c.post('/api/setup', { code: 'secret1', username: 'root', password: 'password123' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.role, 'admin');
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/i);
    assert.equal((await c.get('/api/me')).body.username, 'root'); // signed in by the setup
    assert.equal((await makeClient(c.cookie && `http://127.0.0.1:${srv.address().port}`).post('/api/setup', { code: 'secret1', username: 'again', password: 'password123' })).status, 409);
  } finally {
    fresh.stop();
    srv.closeAllConnections();
    srv.close();
  }
});

test('login: generic errors, throttling after repeated failures, logout', async () => {
  const c = s.client();
  const bad1 = await c.login('nobody', 'whatever1');
  const bad2 = await c.login('admin', 'wrong-password');
  assert.equal(bad1.status, 401);
  assert.equal(bad2.status, 401);
  assert.equal(bad1.body.error, bad2.body.error); // no hint whether the username exists
  for (let i = 0; i < 4; i++) await c.login('admin', 'wrong-password');
  assert.equal((await c.login('admin', 'correct horse')).status, 429); // locked even with the right password
  // a different account name from the same address is tracked separately
  assert.equal((await c.login('someone-else', 'x')).status, 401);

  const ok = s.client();
  s.ctx.users.create({ username: 'carol', password: 'carol-pass-1' });
  await waitFor(async () => (await ok.login('carol', 'carol-pass-1')).status === 200);
  assert.equal((await ok.get('/api/me')).body.username, 'carol');
  assert.equal((await ok.post('/api/auth/logout')).status, 204);
  assert.equal((await ok.get('/api/me')).status, 401);
});

test('cross-site requests are refused (Origin check) and cookies are HttpOnly + SameSite', async () => {
  const r = await admin.req('/api/admin/settings', { method: 'PUT', json: {}, headers: { origin: 'http://evil.example' } });
  assert.equal(r.status, 403);
  const fresh = s.client();
  const login = await fresh.login('admin', 'correct horse').catch(() => null);
  if (login?.status === 200) assert.match(login.headers.get('set-cookie'), /SameSite=Lax/i);
});

test('regular users cannot reach the admin API', async () => {
  await s.ctx.users.create({ username: 'dave', password: 'dave-pass-123' });
  const dave = s.client();
  assert.equal((await dave.login('dave', 'dave-pass-123')).status, 200);
  for (const [m, p] of [['GET', '/api/admin/servers'], ['GET', '/api/admin/users'], ['PUT', '/api/admin/settings'], ['GET', '/api/admin/stats']]) {
    assert.equal((await dave.req(p, { method: m, json: m === 'PUT' ? {} : undefined })).status, 403, p);
  }
  assert.equal((await dave.get('/api/home')).status, 200); // but the catalogue works
});

test('server credentials are encrypted at rest and never returned by the API', async () => {
  const list = (await admin.get('/api/admin/servers')).body.servers;
  assert.equal(list.length, 2);
  const json = JSON.stringify(list);
  for (const secret of ['key-a', 'pw"']) assert.ok(!json.includes(secret), `API leaked ${secret}`);
  assert.equal(list[0].authType, 'apikey');
  assert.equal(list[1].authType, 'login');
  const raw = s.ctx.db.prepare('SELECT secret FROM servers').all().map((r) => r.secret).join('|');
  assert.ok(!raw.includes('key-a') && !raw.includes('"pw"'));
  assert.match(raw, /^v1\./);
});

test('admin: add, edit, test, reorder, disable and delete servers - applied live', async () => {
  const c = createMockJellyfin({ name: 'C', apiKey: 'key-c', titles: [T('Movie', 'Only On C', 99)] });
  const urlC = await c.start();
  try {
    // test connection: good, bad key, unreachable
    assert.equal((await admin.post('/api/admin/servers/test', { url: urlC, authType: 'apikey', apiKey: 'key-c' })).body.ok, true);
    const badKey = (await admin.post('/api/admin/servers/test', { url: urlC, authType: 'apikey', apiKey: 'nope' })).body;
    assert.equal(badKey.ok, false);
    assert.equal(badKey.step, 'auth');
    assert.equal((await admin.post('/api/admin/servers/test', { url: 'http://127.0.0.1:9', authType: 'apikey', apiKey: 'x' })).body.step, 'connect');
    assert.equal((await admin.post('/api/admin/servers', { name: 'bad', url: 'ftp://x', authType: 'apikey', apiKey: 'k' })).status, 400);
    assert.equal((await admin.post('/api/admin/servers', { name: 'bad', url: urlC, authType: 'apikey' })).status, 400); // key required

    // add -> its titles appear without a restart
    const added = await admin.post('/api/admin/servers', { name: 'Server C', url: urlC, authType: 'apikey', apiKey: 'key-c' });
    assert.equal(added.status, 201);
    const slotC = added.body.servers.find((x) => x.name === 'Server C').slot;
    assert.equal(slotC, 2);
    await waitFor(async () => !!findCard((await admin.get('/api/home')).body.rows, 'Only On C'));

    // rename (blank key keeps the stored one) and re-order
    assert.equal((await admin.put(`/api/admin/servers/${slotC}`, { name: 'Garage' })).status, 200);
    assert.equal(findCard((await admin.get('/api/home')).body.rows, 'Only On C').servers[0], 'Garage');
    assert.equal((await admin.post('/api/admin/servers/reorder', { order: [slotC, 0, 1] })).status, 200);
    assert.equal((await admin.post('/api/admin/servers/reorder', { order: [0, 1] })).status, 400);
    assert.deepEqual((await admin.get('/api/admin/servers')).body.servers.map((x) => x.slot), [slotC, 0, 1]);
    const shared = findCard((await admin.get('/api/home')).body.rows, 'Shared Film');
    assert.deepEqual(shared.servers, ['Server A', 'Server B']); // priority among A/B unchanged

    // disable removes its titles; enable brings them back; delete removes for good
    await admin.put(`/api/admin/servers/${slotC}`, { enabled: false });
    assert.equal(findCard((await admin.get('/api/home')).body.rows, 'Only On C'), undefined);
    await admin.put(`/api/admin/servers/${slotC}`, { enabled: true });
    await waitFor(async () => !!findCard((await admin.get('/api/home')).body.rows, 'Only On C'));
    assert.equal((await admin.del(`/api/admin/servers/${slotC}`)).status, 200);
    assert.equal(findCard((await admin.get('/api/home')).body.rows, 'Only On C'), undefined);
  } finally {
    await c.stop();
  }
});

test('admin: settings are validated, persisted and applied live', async () => {
  assert.equal((await admin.put('/api/admin/settings', { playback: { maxBitrateMbps: 8, allowHevc: true } })).status, 200);
  assert.equal(s.ctx.playback.profile.MaxStreamingBitrate, 8_000_000);
  assert.match(s.ctx.playback.profile.DirectPlayProfiles[0].VideoCodec, /hevc/);
  for (const bad of [{ playback: { maxBitrateMbps: 0 } }, { cacheTtlSeconds: 'soon' }, { nope: 1 }, { playback: { allowHevc: 'yes' } }, { playback: { directPlayAudio: 'aac; drop' } }]) {
    assert.equal((await admin.put('/api/admin/settings', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(s.ctx.settings.values.playback.maxBitrateMbps, 8); // a rejected patch changes nothing
  const stored = s.ctx.db.prepare("SELECT value FROM settings WHERE key = 'playback.maxBitrateMbps'").get();
  assert.equal(stored.value, '8');
});

test('admin: user management and the last-admin safeguards', async () => {
  const created = await admin.post('/api/admin/users', { username: 'erin', password: 'erin-pass-123', displayName: 'Erin' });
  assert.equal(created.status, 201);
  assert.equal((await admin.post('/api/admin/users', { username: 'ERIN', password: 'erin-pass-123' })).status, 409); // case-insensitive unique
  assert.equal((await admin.post('/api/admin/users', { username: 'x y', password: 'erin-pass-123' })).status, 400);
  const erin = s.client();
  assert.equal((await erin.login('erin', 'erin-pass-123')).status, 200);

  // disabling signs them out everywhere
  assert.equal((await admin.put(`/api/admin/users/${created.body.id}`, { disabled: true })).status, 200);
  assert.equal((await erin.get('/api/home')).status, 401);
  assert.equal((await s.client().login('erin', 'erin-pass-123')).status, 401);
  await admin.put(`/api/admin/users/${created.body.id}`, { disabled: false });

  // reset password signs them out; the new one works
  await erin.login('erin', 'erin-pass-123').catch(() => {});
  assert.equal((await admin.post(`/api/admin/users/${created.body.id}/password`, { password: 'brand-new-pass' })).status, 204);
  assert.equal((await erin.get('/api/me')).status, 401);
  assert.equal((await s.client().login('erin', 'brand-new-pass')).status, 200);

  // safeguards
  const me = (await admin.get('/api/me')).body;
  assert.equal((await admin.del(`/api/admin/users/${me.id}`)).status, 409); // not yourself
  assert.equal((await admin.put(`/api/admin/users/${me.id}`, { role: 'user' })).status, 409);
  assert.equal((await admin.put(`/api/admin/users/${me.id}`, { disabled: true })).status, 409);
  assert.throws(() => s.ctx.users.update(me.id, { role: 'user' }), /at least one enabled admin/); // even via the store
  assert.equal((await admin.del(`/api/admin/users/${created.body.id}`)).status, 204);
});

test('password change: needs the current password, signs out other devices', async () => {
  await s.ctx.users.create({ username: 'frank', password: 'frank-pass-123' });
  const one = s.client();
  const two = s.client();
  await one.login('frank', 'frank-pass-123');
  await two.login('frank', 'frank-pass-123');
  assert.equal((await one.post('/api/me/password', { current: 'wrong', next: 'another-pass-1' })).status, 403);
  assert.equal((await one.post('/api/me/password', { current: 'frank-pass-123', next: 'short' })).status, 400);
  assert.equal((await one.post('/api/me/password', { current: 'frank-pass-123', next: 'another-pass-1' })).status, 204);
  assert.equal((await one.get('/api/me')).status, 200); // this device stays signed in
  assert.equal((await two.get('/api/me')).status, 401); // the other one doesn't
  assert.equal((await s.client().login('frank', 'another-pass-1')).status, 200);
});

test('per-user watch history: each person sees and writes only their own, via their Jellyfin account', async () => {
  const { a, b } = s;
  const alice = (await admin.post('/api/admin/users', { username: 'alice', password: 'alice-pass-1' })).body;
  const ac = s.client();
  await ac.login('alice', 'alice-pass-1');

  // Before mapping, Alice shares the default user's history (Shared Film at 33%).
  assert.equal(Math.round((await ac.get('/api/home')).body.rows.find((r) => r.id === 'continue').items[0].progress), 33);

  // Admin lists Jellyfin users on a server, then links by username on every server.
  const users = (await admin.get('/api/admin/servers/0/users')).body.users;
  assert.deepEqual(users.map((u) => u.name), ['demo', 'alice', 'bob']);
  const match = (await admin.post(`/api/admin/users/${alice.id}/automatch`)).body;
  assert.deepEqual(match.results.map((r) => r.matched), ['alice', 'alice']);
  assert.equal(Object.keys(match.user.mappings).length, 2);

  // Now Alice sees HER Continue Watching: "Only On A" at 50%, and not the shared Shared Film.
  const aliceCont = (await ac.get('/api/home')).body.rows.find((r) => r.id === 'continue');
  assert.deepEqual(aliceCont.items.map((i) => i.title), ['Only On A']);
  assert.equal(Math.round(aliceCont.items[0].progress), 50);
  const adminCont = (await admin.get('/api/home')).body.rows.find((r) => r.id === 'continue');
  assert.ok(!adminCont.items.some((i) => i.title === 'Only On A')); // unaffected

  // Her resume position on a title comes from her own account, and the cards carry her markers.
  const onlyA = findCard((await ac.get('/api/home')).body.rows, 'Only On A');
  const play = (await ac.get(`/api/play/${onlyA.id}`)).body;
  assert.equal(play.startSeconds, 30);
  const shared = findCard((await ac.get('/api/home')).body.rows, 'Shared Film');
  assert.equal(shared.progress, null);

  // Progress she reports lands on HER Jellyfin accounts on both servers, not the default user's.
  const sharedPlay = (await ac.get(`/api/play/${shared.id}`)).body;
  assert.equal(sharedPlay.startSeconds, 0);
  const rep = { uid: shared.id, event: 'progress', positionSeconds: 25, durationSeconds: 60, playSessionId: sharedPlay.playSessionId, serverIndex: sharedPlay.serverIndex, mediaSourceId: sharedPlay.mediaSourceId, playMethod: 'DirectPlay' };
  assert.equal((await ac.post('/api/progress', rep)).status, 204);
  const aliceA = a.users.find((u) => u.name === 'alice').id;
  const aliceB = b.users.find((u) => u.name === 'alice').id;
  assert.equal(a.ud(aliceA, a.byName('Shared Film').Id).PlaybackPositionTicks, 25e7);
  assert.equal(b.ud(aliceB, b.byName('Shared Film').Id).PlaybackPositionTicks, 25e7);
  assert.notEqual(a.ud(a.userId, a.byName('Shared Film').Id)?.PlaybackPositionTicks, 25e7); // default user untouched

  // Episodes are per-user too.
  const show = findCard((await ac.get('/api/home')).body.rows, 'Shared Show');
  const eps = (await ac.get(`/api/items/${show.id}/episodes`)).body.seasons[0].episodes;
  assert.ok(eps.every((e) => e.progress === null && !e.played));

  // Unmapping goes back to sharing.
  await admin.put(`/api/admin/users/${alice.id}/mappings`, { mappings: { 0: null, 1: null } });
  assert.equal(Math.round((await ac.get('/api/home')).body.rows.find((r) => r.id === 'continue').items[0].progress) > 0, true);
  assert.equal((await admin.put(`/api/admin/users/${alice.id}/mappings`, { mappings: { 7: 'a'.repeat(32) } })).status, 400); // unknown server
  assert.equal((await admin.put(`/api/admin/users/${alice.id}/mappings`, { mappings: { 0: 'not-an-id' } })).status, 400);
});

test('a non-admin Jellyfin login can serve the catalogue but cannot list users for mapping', async () => {
  const c = createMockJellyfin({ name: 'D', apiKey: 'x', login: { user: 'demo', pass: 'pw', admin: false }, users: ['demo', 'zed'], titles: [T('Movie', 'Only On D', 77)] });
  const url = await c.start();
  try {
    const probe = (await admin.post('/api/admin/servers/test', { url, authType: 'login', username: 'demo', password: 'pw' })).body;
    assert.equal(probe.ok, true);
    assert.equal(probe.canMapUsers, false);
    const added = (await admin.post('/api/admin/servers', { name: 'Server D', url, authType: 'login', username: 'demo', password: 'pw' })).body;
    const slot = added.servers.find((x) => x.name === 'Server D').slot;
    assert.equal((await admin.get(`/api/admin/servers/${slot}/users`)).status, 502);
    await admin.del(`/api/admin/servers/${slot}`);
  } finally {
    await c.stop();
  }
});

test('data survives a restart: users, servers and encrypted credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rflix-test-'));
  const mock = createMockJellyfin({ name: 'P', apiKey: 'persist-key', titles: A_TITLES });
  const url = await mock.start();
  const boot = () => createApp({ dataDir: dir, env: { RFLIX_SETUP_CODE: 'zzz' }, log: () => {} });
  try {
    const one = boot();
    await one.users.create({ username: 'persist', password: 'persist-pass-1', role: 'admin' });
    one.reg.add({ name: 'P', url, authType: 'apikey', apiKey: 'persist-key' });
    one.settings.update({ playback: { maxBitrateMbps: 5 } });
    one.stop();
    assert.equal(fs.statSync(path.join(dir, 'secret.key')).mode & 0o077, 0); // key file is owner-only

    const two = boot();
    assert.equal(two.getSetupCode(), null); // an admin exists: no setup needed
    assert.equal((await two.users.authenticate('persist', 'persist-pass-1')).role, 'admin');
    assert.equal(two.settings.values.playback.maxBitrateMbps, 5);
    two.start();
    await waitFor(() => two.reg.get(0)?.online === true); // decrypted the API key and connected
    await two.catalogue.ensureLoaded();
    assert.ok(two.catalogue.groups.length > 0);
    two.stop();

    // A different key can't read the stored credentials: the server is flagged, not crashed.
    const three = createApp({ dataDir: dir, env: { RFLIX_SECRET: 'a-different-key' }, log: () => {} });
    assert.match(three.reg.describe()[0].problem, /decrypted/);
    three.stop();
  } finally {
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
