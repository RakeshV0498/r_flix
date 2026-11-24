/**
 * r_flix front end entry point: a tiny hash router.
 *
 *   #/                 home          #/title/<uid>[?play=1]   title page
 *   #/shows, #/movies  browse        #/watch/<uid>            player
 *   #/search/<text>    search
 *
 * Each view module exports mount(container, params) and may return a cleanup
 * function. Views render into their own container, so a slow view that is
 * superseded by navigation can never draw over the new page.
 */
import { h, debounce } from './util.js';
import { initNav } from './nav.js';
import { initStatus } from './status.js';

const view = document.getElementById('view');
const navEl = document.getElementById('nav');
const searchInput = document.getElementById('search');

const ROUTES = [
  [/^#\/?$/, 'home', () => import('./home.js'), () => ({})],
  [/^#\/movies$/, 'movies', () => import('./browse.js'), () => ({ type: 'Movie' })],
  [/^#\/shows$/, 'shows', () => import('./browse.js'), () => ({ type: 'Series' })],
  [/^#\/search\/(.+)$/, 'search', () => import('./search.js'), (m) => ({ q: decodeURIComponent(m[1]) })],
  [/^#\/title\/([0-9a-f-]+)$/, 'title', () => import('./detail.js'), (m, q) => ({ id: m[1], query: q })],
  [/^#\/watch\/([0-9a-f-]+)$/, 'watch', () => import('./player.js'), (m) => ({ id: m[1], goBack })],
];

let token = 0; // bumps on every navigation; lets us drop results from superseded renders
let cleanup = null;
let current = '';
const scrollMap = new Map(); // hash -> scrollY, restored when you come back
const focusMap = new Map(); //  hash -> href of the focused card, restored on back (handy with a remote)

function goBack() {
  const home = !location.hash || location.hash === '#/';
  if (history.length > 1) {
    if (!home) history.back();
  } else if (!home) location.hash = '#/';
}

async function render() {
  const mine = ++token;
  if (current) {
    scrollMap.set(current, scrollY);
    const href = document.activeElement?.getAttribute?.('href');
    if (href) focusMap.set(current, href);
  }
  try { cleanup?.(); } catch (e) { console.warn('cleanup failed', e); }
  cleanup = null;

  const hash = location.hash || '#/';
  current = hash;
  const [path, qs = ''] = hash.split('?');
  const found = ROUTES.find(([re]) => re.test(path)) || ROUTES[0];
  const [re, name, load, params] = found;
  const container = h('div');
  view.replaceChildren(container);

  document.querySelectorAll('.nav-links a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  if (name === 'search') {
    const q = params(re.exec(path)).q;
    if (searchInput.value !== q) searchInput.value = q;
  } else searchInput.value = '';

  try {
    const mod = await load();
    const result = await mod.mount(container, { ...params(re.exec(path) || [], new URLSearchParams(qs)) });
    if (mine !== token) return void result?.();
    cleanup = result || null;
  } catch (err) {
    console.error(err);
    if (mine === token) container.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'error' }, `Something went wrong: ${err.message}`)));
    return;
  }

  scrollTo(0, scrollMap.get(hash) ?? 0);
  const saved = focusMap.get(hash);
  const target =
    (saved && [...container.querySelectorAll('a[href]')].find((a) => a.getAttribute('href') === saved)) ||
    container.querySelector('[data-autofocus]');
  // Only move focus for keyboard/remote users; on touch or mouse it would just draw a stray focus ring.
  if (document.body.classList.contains('using-keys')) target?.focus({ preventScroll: true });
}

// ---- search box in the top bar
const runSearch = () => {
  const q = searchInput.value.trim();
  const onSearch = location.hash.startsWith('#/search/');
  if (q) {
    const target = `#/search/${encodeURIComponent(q)}`;
    if (onSearch) { history.replaceState(null, '', target); render(); } // no history entry per keystroke
    else location.hash = target;
  } else if (onSearch) location.hash = '#/';
};
searchInput.addEventListener('input', debounce(runSearch, 300));
document.getElementById('search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); searchInput.blur(); });

addEventListener('hashchange', render);
addEventListener('scroll', () => navEl.classList.toggle('scrolled', scrollY > 10), { passive: true });
initNav({ goBack });
initStatus();
render();
