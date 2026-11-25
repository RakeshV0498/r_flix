/**
 * r_flix service worker: makes the page installable and keeps the app SHELL (HTML, CSS, JS) available
 * when the network is slow or away. It deliberately touches nothing else:
 *
 *   - the API (/api/*), video and subtitles (/proxy/*) and artwork go straight to the network, so
 *     nothing signed-in, personal or large is ever stored by this worker;
 *   - shell files are fetched network-first, so an update to r_flix shows up on the next load
 *     (the cache is only a fallback), never a stale app.
 */
const CACHE = 'rflix-shell-v2';
// The WHOLE app shell, so it opens even when the server is slow, restarting or unreachable. (Keep in sync
// with public/js: a test fails if a script is missing from this list.) Video, API and artwork are never listed.
const PRECACHE = [
  '/', '/css/app.css', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png',
  '/js/app.js', '/js/api.js', '/js/util.js', '/js/ui.js', '/js/nav.js', '/js/status.js', '/js/cards.js',
  '/js/auth.js', '/js/account.js', '/js/home.js', '/js/browse.js', '/js/search.js', '/js/detail.js', '/js/player.js',
  '/js/admin.js', '/js/admin-servers.js', '/js/admin-users.js', '/js/admin-settings.js', '/js/admin-status.js',
];
const SHELL = /^\/(?:$|css\/|js\/|vendor\/|icons\/|favicon\.svg$|manifest\.webmanifest$)/;

self.addEventListener('install', (event) => {
  // cache:'reload' fetches fresh copies from the server, bypassing the browser's HTTP cache, so an
  // update never precaches yesterday's scripts.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
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
    // cache:'no-cache' = always ask the server (conditional request), never trust the browser's own
    // HTTP cache: otherwise an old copy could be served as if it were the network's answer.
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    // Offline or the server is down: fall back to what we have (a navigation falls back to the app shell).
    const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('/') : undefined);
    if (hit) return hit;
    throw err;
  }
}
