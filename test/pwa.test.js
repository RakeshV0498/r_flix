import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
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
