import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootStack, findCard, wait } from './helpers.js';
import { UpstreamError } from '../src/jellyfin.js';

let s;
before(async () => {
  s = await bootStack();
});
after(() => s.close());

// A video that is slow to START (Jellyfin beginning a transcode, a cold disk, a remote mount) is
// not a server that is down. Regression test for "No reachable server has this title right now".

test('a slow video start succeeds and does NOT mark the server offline', async (t) => {
  if (!s.a.hasMedia) return t.skip('needs ffmpeg for the test video');
  const rows = (await s.admin.get('/api/home')).body.rows;
  const play = (await s.admin.get(`/api/play/${findCard(rows, 'Only On A').id}`)).body;

  // Ordinary API calls give up after 300 ms here, but the VIDEO may take up to 5 s to start.
  s.ctx.reg.get(0).timeoutMs = 300;
  s.ctx.settings.values.mediaTimeoutSeconds = 5;
  s.a.setDelay(1200, /\/Videos\/.+\/stream/); // the stream takes 1.2 s to begin: 4x the API timeout

  const r = await s.admin.get(play.url, { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206, 'the slow stream should still be served');
  assert.equal(s.ctx.reg.get(0).online, true);
  s.a.setDelay(null);
});

test('a video that never starts gives a timeout error, and the server stays online', async () => {
  if (!s.a.hasMedia) return;
  const rows = (await s.admin.get('/api/home')).body.rows;
  const play = (await s.admin.get(`/api/play/${findCard(rows, 'Only On A').id}`)).body;

  s.ctx.settings.values.mediaTimeoutSeconds = 1; // give up after 1 s
  s.a.setDelay(3000, /\/Videos\/.+\/stream/);
  const r = await s.admin.get(play.url, { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 504);
  assert.match(r.body.error, /taking too long to respond/);
  assert.ok(!/127\.0\.0\.1|:\d{4,5}/.test(r.body.error), 'no address in the message');
  assert.equal(s.ctx.reg.get(0).online, true, 'one slow request must not take the server out of service');

  // ...so the title is still playable straight away.
  s.a.setDelay(null);
  assert.equal((await s.admin.get(`/api/play/${findCard(rows, 'Only On A').id}`)).status, 200);
});

test('an ordinary API call that times out does not mark the server offline; the health check still can', async () => {
  const srv = s.ctx.reg.get(0);
  srv.timeoutMs = 200;
  s.a.setDelay(800, /^\/Items/);
  await assert.rejects(srv.libraryPage(0, 5), (err) => err instanceof UpstreamError && err.timeout === true);
  assert.equal(srv.online, true);
  s.a.setDelay(null);

  // The periodic health check uses its own rule: a server that cannot answer a ping IS marked down.
  s.a.setDelay(5000, /^\/System\/Info\/Public/);
  const check = srv.checkHealth(); // times out after 4 s
  await check;
  assert.equal(srv.online, false);
  s.a.setDelay(null);
  await wait(400); // the monitor (0.2 s in tests) brings it back
  assert.equal(srv.online, true);
  srv.timeoutMs = 1500;
});

test('errors shown to viewers never contain server addresses', async () => {
  const srv = s.ctx.reg.get(1);
  s.b.setDown(true); // connections are dropped: a raw network error
  const err = await srv.json('/Users').catch((e) => e);
  s.b.setDown(false);
  assert.ok(err instanceof UpstreamError);
  assert.match(err.message, /127\.0\.0\.1|unreachable/); // the log keeps the detail
  assert.ok(!/127\.0\.0\.1|:\d{4,5}/.test(err.publicMessage), `leaked: ${err.publicMessage}`);

  // and the HTTP API reports why a title is unavailable, by server name only
  s.b.setDown(true);
  await wait(500);
  const onlyB = findCard((await s.admin.get('/api/home')).body.rows, 'Only On B');
  const r = await s.admin.get(`/api/play/${onlyB.id}`);
  s.b.setDown(false);
  assert.equal(r.status, 503);
  assert.match(r.body.error, /Server B is offline/);
  assert.ok(!/127\.0\.0\.1|:\d{4,5}/.test(r.body.error));
});

test('the new setting is validated and shown on the Admin page API', async () => {
  const ok = await s.admin.put('/api/admin/settings', { mediaTimeoutSeconds: 120 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.values.mediaTimeoutSeconds, 120);
  for (const bad of [5, 9999, 'long']) assert.equal((await s.admin.put('/api/admin/settings', { mediaTimeoutSeconds: bad })).status, 400, String(bad));
});
