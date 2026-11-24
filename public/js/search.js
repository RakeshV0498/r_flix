/** Search results across the merged catalogue (both servers). */
import { h } from './util.js';
import { get } from './api.js';
import { grid } from './cards.js';

export async function mount(root, { q }) {
  const ctl = new AbortController();
  root.replaceChildren(h('div', { class: 'page' }, h('h1', null, `Results for “${q}”`), h('p', { class: 'loading' }, 'Searching…')));
  try {
    const { items } = await get(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
    root.replaceChildren(
      h('div', { class: 'page' }, h('h1', null, `Results for “${q}”`), items.length ? grid(items) : h('p', { class: 'empty' }, 'No matching titles.')),
    );
  } catch (err) {
    if (err.name !== 'AbortError') root.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'error' }, err.message)));
  }
  return () => ctl.abort();
}
