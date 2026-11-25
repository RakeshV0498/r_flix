import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { bootStack, makeClient } from './helpers.js';
import { LoginLimiter } from '../src/auth.js';

let s;
before(async () => {
  s = await bootStack();
});
after(() => s.close());

test('installable app: manifest, icons and service worker are public and well-formed', async () => {
  const anon = makeClient(s.base); // not signed in: the sign-in page itself must be installable
  const m = await anon.get('/manifest.webmanifest');
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /manifest\+json|json/);
  assert.equal(m.headers.get('cache-control'), 'no-cache');
  const manifest = m.body;
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
  assert.deepEqual(sizes, ['192x192:any', '512x512:any', '512x512:maskable']);
  for (const icon of manifest.icons) {
    const r = await fetch(s.base + icon.src);
    assert.equal(r.status, 200, icon.src);
    assert.equal(r.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await r.arrayBuffer());
    assert.equal(png.readUInt32BE(16), Number(icon.sizes.split('x')[0])); // PNG header width matches the manifest
  }
  assert.equal((await fetch(s.base + '/icons/apple-touch-icon.png')).status, 200);

  const sw = await anon.get('/sw.js');
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get('cache-control'), 'no-cache'); // updates must reach installed copies
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.match(await (await fetch(s.base + '/')).text(), /rel="manifest"/);
});

test('app updates reach users immediately: code is always revalidated, never served stale from a cache', async () => {
  // Regression: scripts used to be cached for an hour, so after an update browsers kept running the old
  // player (and its old failure handling) until the cache expired.
  for (const p of ['/', '/index.html', '/js/app.js', '/js/player.js', '/css/app.css', '/sw.js', '/manifest.webmanifest']) {
    const r = await fetch(s.base + p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('cache-control'), 'no-cache', p);
    assert.ok(r.headers.get('etag'), `${p} needs an ETag so revalidation is a cheap 304`);
  }
  // A conditional request for an unchanged file costs almost nothing.
  // (Raw http: fetch() adds "Cache-Control: no-cache" itself when given If-None-Match, which would defeat a 304.)
  const first = await fetch(s.base + '/js/player.js');
  const status = await new Promise((resolve, reject) =>
    http.get(s.base + '/js/player.js', { headers: { 'If-None-Match': first.headers.get('etag') } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(status, 304);
  // Icons never change between versions, so they may be cached for a day.
  assert.match((await fetch(s.base + '/icons/icon-192.png')).headers.get('cache-control'), /max-age=86400/);
  // The service worker must go to the server too, not trust the browser's HTTP cache.
  assert.match(await (await fetch(s.base + '/sw.js')).text(), /fetch\(req, \{ cache: 'no-cache' \}\)/);
});

test('the service worker precaches every script, so the app shell opens offline', async () => {
  const sw = await (await fetch(s.base + '/sw.js')).text();
  const listed = new Set([...sw.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]));
  const dir = new URL('../public/js/', import.meta.url);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    assert.ok(listed.has(`/js/${file}`), `public/js/${file} is missing from PRECACHE in public/sw.js`);
  }
  for (const p of listed) {
    if (p === '/') continue;
    assert.equal((await fetch(s.base + p)).status, 200, `${p} is listed for precaching but is not served`);
  }
});

test('service worker never touches the API, video or artwork', async () => {
  const src = await (await fetch(s.base + '/sw.js')).text();
  // Evaluate the worker's routing rule in isolation, against real URLs.
  const rule = new RegExp(/const SHELL = (\/.*\/);/.exec(src)[1].slice(1, -1));
  for (const p of ['/', '/css/app.css', '/js/app.js', '/js/player.js', '/vendor/hls.min.js', '/icons/icon-192.png', '/favicon.svg', '/manifest.webmanifest']) {
    assert.ok(rule.test(p), `${p} should be cached as shell`);
  }
  for (const p of ['/api/home', '/api/me', '/api/play/abc', '/api/img/abc/Primary', '/proxy/0/Videos/x/stream', '/api/admin/users', '/sw.js']) {
    assert.ok(!rule.test(p), `${p} must go straight to the network`);
  }
});

test('login throttling also works per account, so a forged forwarded address does not help', () => {
  const l = new LoginLimiter({ maxFails: 5, ipMaxFails: 1000, acctMaxFails: 4 });
  // Each attempt claims a different "client address" (as a spoofed X-Forwarded-For would).
  for (let i = 0; i < 3; i++) l.fail(`10.0.0.${i}`, 'Dad');
  assert.equal(l.wait('10.0.0.200', 'dad'), 0);
  l.fail('10.0.0.3', 'dad');
  assert.ok(l.wait('10.0.0.250', 'DAD') > 0); // locked for everyone, whatever address
  assert.equal(l.wait('10.0.0.250', 'mum'), 0); // other accounts unaffected
  l.success('10.0.0.9', 'dad'); // the real owner signing in clears it
  assert.equal(l.wait('10.0.0.250', 'dad'), 0);
  clearInterval(l.timer);
});
