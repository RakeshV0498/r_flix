/** Admin → Status: live view of servers, catalogue size and the app itself. */
import { h } from './util.js';
import { get } from './api.js';
import { date } from './ui.js';

export async function mount(root) {
  const box = h('div');
  root.replaceChildren(box);

  async function load() {
    const [stats, servers] = await Promise.all([get('/api/admin/stats'), get('/api/admin/servers')]);
    const c = stats.catalogue;
    const up = (s) => (s.problem ? 'problem' : !s.enabled ? 'disabled' : s.online === false ? 'offline' : s.authError ? s.authError : s.online === null ? 'checking' : 'online');
    const dotOf = (s) => (s.problem || s.online === false ? 'down' : s.authError ? 'warn' : !s.enabled || s.online === null ? 'wait' : '');
    const mins = Math.floor(stats.uptimeSeconds / 60);
    box.replaceChildren(
      h('section', { class: 'panel' }, h('h3', null, 'Catalogue'),
        h('p', null, `${c.titles} titles: ${c.movies} movies, ${c.series} shows. ${c.onMultipleServers} exist on more than one server and are shown once.`)),
      h('section', { class: 'panel' }, h('h3', null, 'Servers'),
        h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['Server', 'Status', 'Latency', 'Titles', 'Last library refresh'].map((t) => h('th', null, t)))),
          h('tbody', null, servers.servers.map((s) => {
            const lib = c.servers.find((x) => x.slot === s.slot);
            return h('tr', null, h('td', null, s.name), h('td', null, h('i', { class: `dot ${dotOf(s)}` }), ` ${up(s)}`),
              h('td', null, s.latencyMs != null ? `${s.latencyMs} ms` : '–'), h('td', null, String(lib?.items ?? 0)),
              h('td', null, lib?.loading ? 'loading…' : date(lib?.fetchedAt)));
          })))),
      h('section', { class: 'panel' }, h('h3', null, 'r_flix'),
        h('p', null, `${stats.users} user${stats.users === 1 ? '' : 's'} · memory ${stats.memoryMB} MB · up ${mins >= 120 ? `${Math.floor(mins / 60)} h` : `${mins} min`} · Node ${stats.node}`)));
  }
  await load();
  const timer = setInterval(() => load().catch(() => {}), 5000);
  return () => clearInterval(timer);
}
