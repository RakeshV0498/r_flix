/** Movies / Shows grid with genre + sort filters and incremental loading. */
import { h } from './util.js';
import { get } from './api.js';
import { grid } from './cards.js';

const SORTS = [['added', 'Recently added'], ['name', 'A–Z'], ['year', 'Year'], ['rating', 'Rating']];
const PAGE = 60;

export async function mount(root, { type }) {
  const state = { genre: '', sort: 'added', offset: 0, total: 0, busy: false };
  let alive = true;
  const heading = h('h1', null, type === 'Movie' ? 'Movies' : 'TV Shows');
  const sortPills = h('div', { class: 'pills', role: 'group', 'aria-label': 'Sort' });
  const genrePills = h('div', { class: 'pills', role: 'group', 'aria-label': 'Genre' });
  const results = h('div');
  const more = h('button', { class: 'btn', hidden: true, onclick: () => loadPage() }, 'Load more');
  root.replaceChildren(h('div', { class: 'page' }, heading, sortPills, genrePills, results, h('div', null, more)));

  const pill = (label, pressed, onclick) => h('button', { class: 'pill-btn', 'aria-pressed': String(pressed), onclick }, label);

  function drawPills(genres) {
    sortPills.replaceChildren(...SORTS.map(([k, label]) => pill(label, state.sort === k, () => { state.sort = k; reset(); })));
    genrePills.replaceChildren(
      pill('All genres', !state.genre, () => { state.genre = ''; reset(); }),
      ...genres.map((g) => pill(g, state.genre === g, () => { state.genre = g; reset(); })),
    );
  }

  let genres = [];
  function reset() {
    state.offset = 0;
    results.replaceChildren();
    drawPills(genres);
    loadPage();
  }

  async function loadPage() {
    if (state.busy || !alive) return;
    state.busy = true;
    more.hidden = true;
    try {
      const q = new URLSearchParams({ type, sort: state.sort, offset: state.offset, limit: PAGE });
      if (state.genre) q.set('genre', state.genre);
      const d = await get(`/api/browse?${q}`);
      if (!alive) return;
      if (!genres.length) { genres = d.genres; drawPills(genres); }
      state.total = d.total;
      if (state.offset === 0 && !d.items.length) results.replaceChildren(h('p', { class: 'empty' }, 'Nothing here.'));
      else results.append(grid(d.items));
      state.offset += d.items.length;
      more.hidden = state.offset >= state.total;
    } catch (err) {
      results.append(h('p', { class: 'error' }, err.message));
    } finally {
      state.busy = false;
    }
  }

  // Load the next page automatically when the button scrolls into view; the button stays as a fallback.
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((e) => e[0].isIntersecting && !more.hidden && loadPage(), { rootMargin: '400px' }) : null;
  io?.observe(more);

  await loadPage();
  return () => {
    alive = false;
    io?.disconnect();
  };
}
