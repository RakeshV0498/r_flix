/**
 * r_flix service worker: makes the page installable and keeps the app SHELL (HTML, CSS, JS) available
 * when the network is slow or away. It deliberately touches nothing else:
 *
 *   - the API (/api/*), video and subtitles (/proxy/*) and artwork go straight to the network, so
 *     nothing signed-in, personal or large is ever stored by this worker;
 *   - shell files are fetched network-first, so an update to r_flix shows up on the next load
 *     (the cache is only a fallback), never a stale app.
 */
const CACHE = 'rflix-shell-v1';
const PRECACHE = ['/', '/css/app.css', '/js/app.js', '/favicon.svg', '/icons/icon-192.png'];
const SHELL = /^\/(?:$|css\/|js\/|vendor\/|icons\/|favicon\.svg$|manifest\.webmanifest$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || !SHELL.test(url.pathname)) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    // Offline or the server is down: fall back to what we have (a navigation falls back to the app shell).
    const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('/') : undefined);
    if (hit) return hit;
    throw err;
  }
}
