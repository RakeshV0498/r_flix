/** Admin → Servers: add / edit / test / reorder / disable / delete Jellyfin servers. Changes apply live. */
import { h } from './util.js';
import { get, post, put, del } from './api.js';
import { field, check, notice, run } from './ui.js';

function statusOf(s) {
  if (s.problem) return ['down', s.problem];
  if (!s.enabled) return ['wait', 'disabled'];
  if (s.online === false) return ['down', 'offline'];
  if (s.authError) return ['warn', s.authError];
  if (s.online === null) return ['wait', 'checking…'];
  return ['', `online${s.latencyMs != null ? ` · ${s.latencyMs} ms` : ''}`];
}

export async function mount(root) {
  let servers = [];
  let editing = null; // slot number, 'new', or null
  const note = notice();
  const list = h('div', { class: 'server-list' });
  root.replaceChildren(
    h('div', { class: 'toolbar' },
      h('p', { class: 'muted' }, 'The order is the priority: when a title is on several servers, the first reachable one is used. Changes apply immediately.'),
      h('button', { class: 'btn primary', onclick: () => { editing = 'new'; draw(); } }, '+ Add server')),
    note.el, list);

  async function load() {
    servers = (await get('/api/admin/servers')).servers;
    draw();
  }

  async function reorder(slot, dir) {
    const order = servers.map((s) => s.slot);
    const i = order.indexOf(slot);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    try {
      servers = (await post('/api/admin/servers/reorder', { order })).servers;
      draw();
    } catch (err) { note.show(err.message, 'error'); }
  }

  function draw() {
    list.replaceChildren(
      ...[
        editing === 'new' ? form(null) : null,
        ...servers.map((s, i) => (editing === s.slot ? form(s) : card(s, i))),
        !servers.length && editing !== 'new' ? h('p', { class: 'empty' }, 'No servers yet. Add your first Jellyfin server.') : null,
      ].filter(Boolean)); // (replaceChildren would turn a null into the text "null")
  }

  function card(s, i) {
    const [cls, text] = statusOf(s);
    const refreshNote = notice();
    const refresh = h('button', { class: 'btn small', onclick: async (e) => {
      const r = await run(e.target, refreshNote, () => post(`/api/admin/servers/${s.slot}/refresh`));
      if (r) refreshNote.show(`Library reloaded: ${r.servers.find((x) => x.slot === s.slot)?.items ?? 0} items.`);
    } }, 'Reload library');
    return h('section', { class: `panel server-card${s.enabled ? '' : ' off'}` },
      h('div', { class: 'row-between' },
        h('div', null,
          h('h3', null, `${i + 1}. ${s.name}`),
          h('p', { class: 'muted' }, `${s.url} · ${s.authType === 'apikey' ? 'API key' : `login (${s.username})`}${s.version ? ` · Jellyfin ${s.version}` : ''}`)),
        h('span', { class: 'status-pill' }, h('i', { class: `dot ${cls}` }), text)),
      s.lastError && s.online === false ? h('p', { class: 'muted small' }, s.lastError) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', disabled: i === 0, 'aria-label': 'Higher priority', onclick: () => reorder(s.slot, -1) }, '↑'),
        h('button', { class: 'btn small', disabled: i === servers.length - 1, 'aria-label': 'Lower priority', onclick: () => reorder(s.slot, 1) }, '↓'),
        h('button', { class: 'btn small', onclick: () => { editing = s.slot; draw(); } }, 'Edit'),
        refresh),
      refreshNote.el);
  }

  function form(existing) {
    const fnote = notice();
    const name = h('input', { type: 'text', value: existing?.name ?? '', maxlength: '60', required: true, placeholder: 'Living Room' });
    const url = h('input', { type: 'url', value: existing?.url ?? '', required: true, placeholder: 'http://192.168.1.10:8096', autocapitalize: 'none', spellcheck: 'false' });
    const radio = (value, label) => {
      const r = h('input', { type: 'radio', name: 'auth', value, checked: (existing?.authType ?? 'apikey') === value, onchange: sync });
      return h('label', { class: 'check' }, r, h('span', null, label));
    };
    const apiKey = h('input', { type: 'password', autocomplete: 'off', placeholder: existing ? '•••••••• (saved: leave blank to keep)' : 'Paste the API key from Jellyfin' });
    const user = h('input', { type: 'text', autocomplete: 'off', value: existing?.username ?? '', autocapitalize: 'none' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: existing ? '•••••••• (saved: leave blank to keep)' : '' });
    const enabled = check('Enabled', existing ? existing.enabled : true);
    const keyField = field('API key', apiKey, 'Jellyfin Dashboard → API Keys');
    const userField = field('Jellyfin username', user);
    const passField = field('Password', pass);

    function authType() { return form.querySelector('input[name=auth]:checked').value; }
    function sync() {
      const key = authType() === 'apikey';
      keyField.hidden = !key;
      passField.hidden = key;
      userField.querySelector('.field-label').textContent = key ? 'Default Jellyfin user (optional)' : 'Jellyfin username';
      userField.querySelector('.help')?.remove();
      userField.append(h('span', { class: 'help' }, key
        ? 'Used for the shared library and for people with no personal mapping. Blank = the first administrator.'
        : 'This account must be able to see your libraries. For per-person watch history, use an API key or an administrator login.'));
    }
    const payload = () => ({ name: name.value, url: url.value, authType: authType(), apiKey: apiKey.value, username: user.value, password: pass.value, enabled: enabled.input.checked });

    const testBtn = h('button', { class: 'btn', type: 'button', onclick: async (e) => {
      const r = await run(e.target, fnote, () => post('/api/admin/servers/test', { ...payload(), slot: existing?.slot }));
      if (!r) return;
      if (!r.ok) return fnote.show(r.error, 'error');
      fnote.show(`Connected to ${r.serverName || 'Jellyfin'}${r.version ? ` ${r.version}` : ''}.${r.catalogueUser ? ` Library user: ${r.catalogueUser}.` : ''} ${
        r.canMapUsers ? `Per-person watch history is available (${r.userCount} Jellyfin users).` : 'Per-person watch history is NOT available with these credentials (use an API key or an administrator login).'}`);
    } }, 'Test connection');
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, existing ? 'Save' : 'Add server');
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => { editing = null; draw(); } }, 'Cancel');
    const remove = existing && h('button', { class: 'btn danger', type: 'button', onclick: async (e) => {
      if (!confirm(`Delete "${existing.name}"? Its titles disappear from r_flix and user mappings to it are removed. Nothing is changed on the Jellyfin server.`)) return;
      const r = await run(e.target, fnote, () => del(`/api/admin/servers/${existing.slot}`));
      if (r) { servers = r.servers; editing = null; draw(); }
    } }, 'Delete');

    const form = h('form', { class: 'panel form server-form', onsubmit: async (e) => {
      e.preventDefault();
      const r = await run(saveBtn, fnote, () => (existing ? put(`/api/admin/servers/${existing.slot}`, payload()) : post('/api/admin/servers', payload())));
      if (r) { servers = r.servers; editing = null; draw(); }
    } },
      h('h3', null, existing ? `Edit ${existing.name}` : 'Add a Jellyfin server'),
      field('Name', name, 'Shown in the status indicator'),
      field('Address', url, 'The LAN address of the Jellyfin server, including the port'),
      h('fieldset', { class: 'fieldset' }, h('legend', null, 'Sign in with'), radio('apikey', 'API key (recommended)'), radio('login', 'Username and password')),
      keyField, userField, passField,
      existing ? enabled.el : null,
      fnote.el,
      h('div', { class: 'btn-row' }, saveBtn, testBtn, cancel, remove));
    sync();
    queueMicrotask(() => name.focus());
    return form;
  }

  const timer = setInterval(() => !editing && load().catch(() => {}), 5000); // keep statuses fresh
  await load();
  return () => clearInterval(timer);
}
