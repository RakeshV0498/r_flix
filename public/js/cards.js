/** Shared UI pieces: title cards and horizontally scrolling rows. */
import { h } from './util.js';
import { img, hrefFor } from './api.js';

/**
 * One title card.
 * @param {object} item  card JSON from the backend
 * @param {'poster'|'landscape'} kind
 * @param {{play?:boolean}} [opts] play: clicking a movie starts it (used by Continue Watching)
 */
export function card(item, kind, { play = false } = {}) {
  const src = kind === 'poster' ? img(item.id, 'Primary', 300) : img(item.id, item.type === 'Episode' ? 'Primary' : 'Landscape', 600);
  const picture = h('img', { src, alt: '', loading: 'lazy', decoding: 'async' });
  // No artwork? Drop the broken image and let the title text show through.
  picture.addEventListener('error', () => picture.remove());

  const thumb = h('div', { class: 'thumb' }, h('div', { class: 'fallback' }, item.title), picture);
  if (item.progress != null) thumb.append(h('div', { class: 'bar' }, bar(item.progress)));
  if (!item.available) thumb.append(h('span', { class: 'chip off' }, 'Offline'));
  else if (item.played && item.type !== 'Series') thumb.append(h('span', { class: 'chip done' }, '✓'));
  if (item.servers.length > 1) thumb.append(h('span', { class: 'chip srv' }, item.servers.join(' + ')));

  return h(
    'a',
    {
      class: `card ${kind}${item.available ? '' : ' unavailable'}`,
      href: hrefFor(item, { play }),
      title: [item.title, item.subtitle, item.year].filter(Boolean).join(' · '),
    },
    thumb,
    h('div', { class: 'card-title' }, item.title),
    item.subtitle ? h('div', { class: 'card-sub' }, item.subtitle) : item.year ? h('div', { class: 'card-sub' }, String(item.year)) : null,
  );
}

function bar(pct) {
  const fill = h('i');
  fill.style.width = `${Math.max(2, Math.min(100, pct))}%`; // CSSOM is allowed by our CSP; inline attributes are not
  return fill;
}

/** A titled, horizontally scrolling row with mouse arrows (keyboard/touch scroll natively). */
export function row({ title, items, kind, more, play }) {
  const track = h('div', { class: 'track' }, items.map((it) => card(it, kind, { play })));
  const scrollBy = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: 'smooth' });
  return h(
    'section',
    { class: 'row', 'aria-label': title },
    h('div', { class: 'row-head' }, h('h2', null, title), more ? h('a', { class: 'more', href: more }, 'See all ›') : null),
    h(
      'div',
      { class: 'row-wrap' },
      h('button', { class: 'arrow prev', tabindex: '-1', 'aria-hidden': 'true', onclick: () => scrollBy(-1) }, '‹'),
      track,
      h('button', { class: 'arrow next', tabindex: '-1', 'aria-hidden': 'true', onclick: () => scrollBy(1) }, '›'),
    ),
  );
}

export function grid(items, kind = 'poster') {
  return h('div', { class: 'grid' }, items.map((it) => card(it, kind)));
}
