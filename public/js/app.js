/**
 * r_flix front end entry point.
 *
 * Boot: is this a fresh install? -> setup page. Signed in? -> the app. Otherwise -> sign-in page.
 * The app is a tiny hash router:
 *
 *   #/                 home          #/title/<uid>[?play=1]   title page
 *   #/shows, #/movies  browse        #/watch/<uid>            player
 *   #/search/<text>    search        #/account                my account
 *   #/admin[/<tab>]    admin (servers, users, settings, status)
 *
 * Each view module exports mount(container, params) and may return a cleanup function. Views
 * render into their own container, so a slow view that is superseded by navigation can never
 * draw over the new page.
 */
import { h, debounce } from './util.js';
import { get, post } from './api.js';
import { initNav } from './nav.js';
import { startStatus, stopStatus } from './status.js';

const view = document.getElementById('view');
const navEl = document.getElementById('nav');
const searchInput = document.getElementById('search');
const userEl = document.getElementById('user');
const adminLink = document.getElementById('admin-link');

const state = { user: null, wired: false };

const ROUTES = [
  [/^#\/?$/, 'home', () => import('./home.js'), () => ({})],
  [/^#\/movies$/, 'movies', () => import('./browse.js'), () => ({ type: 'Movie' })],
  [/^#\/shows$/, 'shows', () => import('./browse.js'), () => ({ type: 'Series' })],
  [/^#\/search\/(.+)$/, 'search', () => import('./search.js'), (m) => ({ q: decodeURIComponent(m[1]) })],
  [/^#\/title\/([0-9a-f-]+)$/, 'title', () => import('./detail.js'), (m, q) => ({ id: m[1], query: q })],
  [/^#\/watch\/([0-9a-f-]+)$/, 'watch', () => import('./player.js'), (m) => ({ id: m[1], goBack })],
  [/^#\/account$/, 'account', () => import('./account.js'), () => ({ user: state.user, onUser: setUser, onSignOut: signOut })],
  [/^#\/admin(?:\/(servers|users|settings|status))?$/, 'admin', () => import('./admin.js'), (m) => ({ tab: m[1], user: state.user })],
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

function teardown() {
  token++; // invalidate any render in flight
  try { cleanup?.(); } catch (e) { console.warn('cleanup failed', e); }
  cleanup = null;
}

async function render() {
  if (!state.user) return;
  const mine = ++token;
  if (current) {
    scrollMap.set(current, scrollY);
    const href = document.activeElement?.getAttribute?.('href');
    if (href) focusMap.set(current, href);
  }
  try { cleanup?.(); } catch (e) { console.warn('cleanup failed', e); }
  cleanup = null;
  userEl.querySelector('.menu')?.setAttribute('hidden', '');

  const hash = location.hash || '#/';
  current = hash;
  const [path, qs = ''] = hash.split('?');
  const found = ROUTES.find(([re]) => re.test(path)) || ROUTES[0];
  const [re, name, load, params] = found;
  const container = h('div');
  view.replaceChildren(container);

  document.querySelectorAll('.nav-links a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  // Pages with long content get a solid top bar; home and title pages let artwork show through it.
  navEl.classList.toggle('solid', !['home', 'title'].includes(name));
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
    if (err.status === 401) return; // the unauthorized handler shows the sign-in page
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

// ---------------------------------------------------------------- account menu
function setUser(user) {
  state.user = user;
  adminLink.hidden = user.role !== 'admin';
  const menu = h('div', { class: 'menu', hidden: true, role: 'menu' },
    h('div', { class: 'menu-head' }, h('b', null, user.displayName), h('span', { class: 'muted small' }, `@${user.username}`)),
    h('a', { href: '#/account', role: 'menuitem' }, 'My account'),
    user.role === 'admin' ? h('a', { href: '#/admin', role: 'menuitem' }, 'Admin') : null,
    h('button', { type: 'button', role: 'menuitem', onclick: signOut }, 'Sign out'));
  const btn = h('button', { class: 'user-btn', type: 'button', 'aria-haspopup': 'true', 'aria-label': `Account menu for ${user.displayName}`, onclick: (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  } }, h('span', { class: 'avatar' }, (user.displayName || user.username).slice(0, 1).toUpperCase()));
  userEl.replaceChildren(btn, menu);
}
addEventListener('click', () => userEl.querySelector('.menu')?.setAttribute('hidden', ''));
addEventListener('keydown', (e) => { if (e.key === 'Escape') userEl.querySelector('.menu')?.setAttribute('hidden', ''); });

async function signOut() {
  try { await post('/api/auth/logout', {}, { quiet401: true }); } catch { /* signed out anyway */ }
  showLogin();
}

// ---------------------------------------------------------------- signed in / out
async function enter(user) {
  setUser(user);
  document.body.classList.remove('signed-out');
  wire();
  startStatus();
  if (!location.hash || /^#\/(login|setup)/.test(location.hash)) history.replaceState(null, '', '#/');
  current = '';
  render();
}

/** One-time listeners that only make sense once the app is running. */
function wire() {
  if (state.wired) return;
  state.wired = true;
  searchInput.addEventListener('input', debounce(runSearch, 300));
  document.getElementById('search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); searchInput.blur(); });
  addEventListener('hashchange', render);
  addEventListener('scroll', () => navEl.classList.toggle('scrolled', scrollY > 10), { passive: true });
  initNav({ goBack });
}

const runSearch = () => {
  const q = searchInput.value.trim();
  const onSearch = location.hash.startsWith('#/search/');
  if (q) {
    const target = `#/search/${encodeURIComponent(q)}`;
    if (onSearch) { history.replaceState(null, '', target); render(); } // no history entry per keystroke
    else location.hash = target;
  } else if (onSearch) location.hash = '#/';
};

async function showLogin(message) {
  teardown();
  state.user = null;
  stopStatus();
  document.body.classList.add('signed-out');
  document.body.classList.remove('in-player');
  const { mountLogin } = await import('./auth.js');
  mountLogin(view, { message, onDone: enter });
}

async function showSetup() {
  document.body.classList.add('signed-out');
  const { mountSetup } = await import('./auth.js');
  mountSetup(view, { onDone: (user) => { location.hash = '#/admin/servers'; enter(user); } });
}

addEventListener('rflix:unauthorized', () => {
  if (state.user) showLogin('Your session ended. Please sign in again.');
});

(async function boot() {
  try {
    const first = await get('/api/setup/state');
    if (first.needsSetup) return showSetup();
    return first.user ? enter(first.user) : showLogin();
  } catch (err) {
    view.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'error' }, err.message)));
  }
})();
