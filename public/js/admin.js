/** Admin page shell: tabs for Servers, Users, Settings and Status. Each tab is its own module. */
import { h } from './util.js';

const TABS = [
  ['servers', 'Servers', () => import('./admin-servers.js')],
  ['users', 'Users', () => import('./admin-users.js')],
  ['settings', 'Settings', () => import('./admin-settings.js')],
  ['status', 'Status', () => import('./admin-status.js')],
];

export async function mount(root, { tab, user }) {
  if (user.role !== 'admin') {
    root.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'error' }, 'This page is for administrators.')));
    return;
  }
  const current = TABS.find(([k]) => k === tab) || TABS[0];
  const body = h('div', { class: 'admin-body' });
  root.replaceChildren(h('div', { class: 'page admin' },
    h('h1', null, 'Admin'),
    h('nav', { class: 'tabs', 'aria-label': 'Admin sections' },
      TABS.map(([k, label]) => h('a', { class: 'tab', href: `#/admin/${k}`, 'aria-current': k === current[0] ? 'page' : null }, label))),
    body));
  try {
    const mod = await current[2]();
    return await mod.mount(body, { user });
  } catch (err) {
    console.error(err);
    body.replaceChildren(h('p', { class: 'error' }, `Could not load this section: ${err.message}`));
  }
}
