/** Home: hero banner + rows (Continue Watching, Recently Added, Movies, TV Shows, genres). */
import { h, fmtRuntime } from './util.js';
import { get, img } from './api.js';
import { row } from './cards.js';

export function metaLine(item) {
  return h(
    'div',
    { class: 'meta' },
    item.rating ? h('span', { class: 'match' }, `★ ${item.rating}`) : null,
    item.year ? h('span', null, String(item.year)) : null,
    item.officialRating ? h('span', { class: 'pill' }, item.officialRating) : null,
    item.runtime ? h('span', null, fmtRuntime(item.runtime)) : null,
    item.type === 'Series' ? h('span', null, 'Series') : null,
    item.genres.length ? h('span', null, item.genres.slice(0, 3).join(' · ')) : null,
  );
}

function hero(item) {
  const playHref = item.type === 'Movie' ? `#/watch/${item.id}` : `#/title/${item.id}?play=1`;
  const backdrop = h('img', { class: 'hero-img', src: img(item.id, 'Backdrop', 1280), alt: '', decoding: 'async' });
  backdrop.addEventListener('error', () => backdrop.remove());
  const title = h('h1', { class: 'hero-title' }, item.title);
  // Prefer the title's logo artwork; fall back to plain text if it fails to load.
  if (item.logo) {
    const logo = h('img', { class: 'hero-logo', src: img(item.id, 'Logo', 500), alt: item.title });
    logo.addEventListener('error', () => logo.replaceWith(title));
    return build(logo);
  }
  return build(title);

  function build(heading) {
    return h(
      'section',
      { class: 'hero', 'aria-label': 'Featured' },
      backdrop,
      h(
        'div',
        { class: 'hero-body' },
        heading,
        metaLine(item),
        h('p', { class: 'hero-text' }, item.overview),
        h('div', { class: 'actions' },
          h('a', { class: 'btn primary', href: playHref, 'data-autofocus': '' }, '▶ Play'),
          h('a', { class: 'btn', href: `#/title/${item.id}` }, 'ⓘ More Info')),
      ),
    );
  }
}

export async function mount(root) {
  root.replaceChildren(h('div', { class: 'loading' }, 'Loading your library…'));
  let alive = true;

  async function load(initial) {
    try {
      const data = await get('/api/home');
      if (!alive) return;
      if (!initial) {
        // A server came or went: refresh quietly, keeping scroll position.
        const y = scrollY;
        draw(data);
        scrollTo(0, y);
      } else draw(data);
    } catch (err) {
      if (initial && alive) root.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'error' }, err.message)));
    }
  }

  function draw(data) {
    const frag = document.createDocumentFragment();
    if (data.featured) frag.append(hero(data.featured));
    const rows = h('div', { class: `rows${data.featured ? '' : ' no-hero'}` });
    for (const r of data.rows) rows.append(row({ ...r, play: r.id === 'continue' }));
    if (!data.rows.length) rows.append(h('div', { class: 'page' }, h('p', { class: 'empty' }, 'No titles found yet. Is a Jellyfin server reachable and does the configured user have libraries?')));
    frag.append(rows);
    root.replaceChildren(frag);
  }

  const onStatus = () => load(false);
  addEventListener('statuschange', onStatus);
  await load(true);
  return () => {
    alive = false;
    removeEventListener('statuschange', onStatus);
  };
}
