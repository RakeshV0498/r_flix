/**
 * Server status indicator: one dot per Jellyfin server (green = ok, amber = login
 * problem, red = unreachable) plus a banner when something is down. The app keeps
 * working from whichever server is up; this just says what's going on.
 */
import { h } from './util.js';
import { get } from './api.js';

let last = '';

function render(servers) {
  const pill = document.getElementById('status');
  pill.replaceChildren(
    ...servers.map((s) => {
      const cls = !s.online ? 'down' : s.authError ? 'warn' : s.checking ? 'wait' : '';
      const label = !s.online ? 'offline' : s.authError ? 'login problem' : s.checking ? 'checking…' : 'online';
      return h('span', { class: 'srv', title: `${s.name}: ${label}` }, h('i', { class: `dot ${cls}` }), h('span', { class: 'name' }, s.name));
    }),
  );
  const bad = servers.filter((s) => !s.online);
  const banner = document.getElementById('banner');
  if (!bad.length) banner.hidden = true;
  else {
    banner.hidden = false;
    banner.textContent =
      bad.length === servers.length
        ? 'No servers reachable. Showing the last known library.'
        : `${bad.map((s) => s.name).join(', ')} offline. Using the other server${servers.length - bad.length > 1 ? 's' : ''}.`;
  }
  // Tell pages when the set of reachable servers changes so they can refresh.
  const sig = servers.map((s) => `${s.index}:${s.online}`).join(',');
  if (last && sig !== last) dispatchEvent(new CustomEvent('statuschange'));
  last = sig;
}

async function poll() {
  try {
    render((await get('/api/status')).servers);
  } catch {
    document.getElementById('banner').hidden = false;
    document.getElementById('banner').textContent = 'Lost connection to r_flix.';
  }
}

export function initStatus() {
  poll();
  setInterval(poll, 15000);
}
