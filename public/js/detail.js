/** Title page: details, play/resume, and (for series) seasons + episodes. */
import { h, fmtRuntime, fmtTime } from './util.js';
import { get, img } from './api.js';
import { metaLine } from './home.js';

/** Which episode should "Play" start? In-progress first, then first unwatched, else the first. */
export function pickEpisode(flat) {
  const resume = flat.find((e) => e.progress != null && !e.played);
  const next = resume || flat.find((e) => !e.played && e.season !== 0) || flat.find((e) => !e.played);
  return { ep: next || flat[0], resuming: !!resume, rewatch: !next };
}

export async function mount(root, { id, query }) {
  root.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
  let d;
  try {
    d = await get(`/api/items/${id}`);
  } catch (err) {
    root.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'error' }, err.message)));
    return;
  }

  let seasons = [];
  let playHref = `#/watch/${id}`;
  let playLabel = d.resumeSeconds > 0 ? `▶ Resume · ${fmtTime(d.resumeSeconds)}` : '▶ Play';

  if (d.type === 'Series') {
    try {
      seasons = (await get(`/api/items/${id}/episodes`)).seasons;
    } catch (err) {
      root.replaceChildren(h('div', { class: 'page' }, h('h1', null, d.title), h('p', { class: 'error' }, err.message)));
      return;
    }
    const flat = seasons.flatMap((s) => s.episodes);
    if (flat.length) {
      const { ep, resuming } = pickEpisode(flat);
      playHref = `#/watch/${ep.id}`;
      playLabel = `▶ ${resuming ? 'Resume' : 'Play'} S${ep.season}:E${ep.number ?? '?'}`;
      // Hero "Play" on a series lands here with ?play=1: jump straight into the episode.
      // Replace the URL first so Back returns to a normal title page instead of re-triggering autoplay.
      if (query.get('play') === '1' && ep.available) {
        history.replaceState(null, '', `#/title/${id}`);
        location.hash = playHref.slice(1);
        return;
      }
    }
  }

  const backdrop = h('img', { class: 'hero-img', src: img(id, 'Backdrop', 1280), alt: '' });
  backdrop.addEventListener('error', () => backdrop.remove());
  const poster = h('img', { src: img(id, 'Primary', 400), alt: '' });
  poster.addEventListener('error', () => poster.remove());

  const canPlay = d.available && (d.type === 'Movie' || seasons.length);
  const facts = [
    d.directors.length ? h('div', { class: 'facts' }, h('b', null, 'Director: '), d.directors.join(', ')) : null,
    d.cast.length ? h('div', { class: 'facts' }, h('b', null, 'Cast: '), d.cast.map((c) => c.name).join(', ')) : null,
    d.studios.length ? h('div', { class: 'facts' }, h('b', null, 'Studio: '), d.studios.join(', ')) : null,
    d.servers.length ? h('div', { class: 'facts' }, h('b', null, 'Available on: '), d.servers.join(' + ')) : null,
  ];

  const hero = h(
    'section',
    { class: 'detail-hero' },
    backdrop,
    h(
      'div',
      { class: 'detail-body' },
      h('div', { class: 'detail-poster' }, h('div', { class: 'thumb' }, poster)),
      h(
        'div',
        { class: 'detail-text' },
        h('h1', null, d.title),
        d.tagline ? h('p', { class: 'tagline' }, d.tagline) : null,
        metaLine(d),
        h('p', { class: 'overview' }, d.overview),
        h('div', { class: 'actions' },
          canPlay ? h('a', { class: 'btn primary', href: playHref, 'data-autofocus': '' }, playLabel) : h('button', { class: 'btn', disabled: true }, 'Unavailable'),
          h('a', { class: 'btn', href: '#/', onclick: (e) => { e.preventDefault(); history.back(); } }, '← Back')),
        d.available ? null : h('p', { class: 'notice' }, 'The server holding this title is offline right now.'),
        ...facts,
      ),
    ),
  );

  const parts = [hero];
  let cleanup;
  if (seasons.length) {
    const list = h('div', { class: 'ep-list' });
    const pills = h('div', { class: 'pills', role: 'group', 'aria-label': 'Seasons' });
    const heading = h('h2', null, 'Episodes');
    const flat = seasons.flatMap((s) => s.episodes);
    let current = pickEpisode(flat).ep?.season ?? seasons[0].number;
    if (!seasons.some((s) => s.number === current)) current = seasons[0].number;

    const draw = () => {
      pills.replaceChildren(
        ...seasons.map((s) => h('button', { class: 'pill-btn', 'aria-pressed': String(s.number === current), onclick: () => { current = s.number; draw(); } }, s.name)),
      );
      const season = seasons.find((s) => s.number === current);
      list.replaceChildren(...season.episodes.map(episode));
    };
    parts.push(h('section', { class: 'episodes' }, heading, pills, list));
    draw();
  }
  root.replaceChildren(...parts);
  return cleanup;
}

function episode(e) {
  const pic = h('img', { src: img(e.id, 'Primary', 400), alt: '', loading: 'lazy', decoding: 'async' });
  pic.addEventListener('error', () => pic.remove());
  const thumb = h('div', { class: 'ep-thumb' }, pic);
  if (e.progress != null) {
    const fill = h('i');
    fill.style.width = `${Math.max(2, e.progress)}%`;
    thumb.append(h('div', { class: 'bar' }, fill));
  }
  return h(
    'a',
    { class: `ep${e.available ? '' : ' unavailable'}`, href: `#/watch/${e.id}` },
    h('div', { class: 'ep-n' }, e.number != null ? String(e.number) : '•'),
    thumb,
    h('div', null,
      h('div', { class: 'ep-head' }, h('span', null, `${e.title}${e.played ? '  ✓' : ''}`), h('span', null, fmtRuntime(e.runtime))),
      h('div', { class: 'ep-overview' }, e.overview)),
  );
}
