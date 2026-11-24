/**
 * Admin → Users: create people, set roles, reset passwords, and link each person to their own
 * Jellyfin account on every server (so they get their own watch history and Continue Watching).
 */
import { h } from './util.js';
import { get, post, put, del } from './api.js';
import { field, check, notice, run, date } from './ui.js';

export async function mount(root, { user: me }) {
  let users = [];
  let servers = [];
  let editing = null; // user id, 'new' or null
  const note = notice();
  const list = h('div', { class: 'user-list' });
  root.replaceChildren(
    h('div', { class: 'toolbar' },
      h('p', { class: 'muted' }, 'Each person signs in to r_flix with their own account. Link them to their Jellyfin account on each server to give them separate watch history.'),
      h('button', { class: 'btn primary', onclick: () => { editing = 'new'; draw(); } }, '+ Add user')),
    note.el, list);

  async function load() {
    [users, servers] = await Promise.all([get('/api/admin/users').then((r) => r.users), get('/api/admin/servers').then((r) => r.servers)]);
    draw();
  }

  function draw() {
    list.replaceChildren(
      ...[editing === 'new' ? createForm() : null, ...users.map((u) => (editing === u.id ? editor(u) : row(u)))].filter(Boolean));
  }

  function row(u) {
    const mapped = Object.keys(u.mappings).length;
    return h('section', { class: `panel user-row${u.disabled ? ' off' : ''}` },
      h('div', { class: 'row-between' },
        h('div', null,
          h('h3', null, u.displayName, u.id === me.id ? h('span', { class: 'badge' }, 'you') : null, u.role === 'admin' ? h('span', { class: 'badge admin' }, 'admin') : null, u.disabled ? h('span', { class: 'badge off' }, 'disabled') : null),
          h('p', { class: 'muted' }, `@${u.username} · last sign-in ${date(u.lastLogin)} · ${mapped ? `own history on ${mapped} of ${servers.length} server${servers.length === 1 ? '' : 's'}` : 'shared watch history'}`)),
        h('button', { class: 'btn small', onclick: () => { editing = u.id; draw(); } }, 'Manage')));
  }

  function createForm() {
    const fnote = notice();
    const username = h('input', { type: 'text', required: true, minlength: '3', maxlength: '32', autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off' });
    const display = h('input', { type: 'text', maxlength: '60', autocomplete: 'off' });
    const pass = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
    const role = h('select', null, h('option', { value: 'user' }, 'Member'), h('option', { value: 'admin' }, 'Administrator'));
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create user');
    const form = h('form', { class: 'panel form', onsubmit: async (e) => {
      e.preventDefault();
      const u = await run(btn, fnote, () => post('/api/admin/users', { username: username.value.trim(), displayName: display.value.trim(), password: pass.value, role: role.value }));
      if (u) { editing = u.id; await load(); }
    } },
      h('h3', null, 'Add a user'),
      field('Username', username, 'Letters, numbers, . _ - (3-32 characters)'),
      field('Display name (optional)', display),
      field('Initial password', pass, 'At least 8 characters. They can change it under My account.'),
      field('Role', role),
      fnote.el,
      h('div', { class: 'btn-row' }, btn, h('button', { class: 'btn', type: 'button', onclick: () => { editing = null; draw(); } }, 'Cancel')));
    queueMicrotask(() => username.focus());
    return form;
  }

  function editor(u) {
    const self = u.id === me.id;
    const pnote = notice();
    const display = h('input', { type: 'text', value: u.displayName, maxlength: '60' });
    const role = h('select', { disabled: self }, h('option', { value: 'user', selected: u.role === 'user' }, 'Member'), h('option', { value: 'admin', selected: u.role === 'admin' }, 'Administrator'));
    const disabled = check('Account disabled (signed out, cannot sign in)', u.disabled);
    disabled.input.disabled = self;
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    const profile = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const r = await run(saveBtn, pnote, () => put(`/api/admin/users/${u.id}`, { displayName: display.value, role: role.value, disabled: disabled.input.checked }));
      if (r) { pnote.show('Saved.'); await load(); editing = u.id; draw(); }
    } }, field('Display name', display), field('Role', role), disabled.el, self ? h('p', { class: 'muted small' }, 'You cannot demote, disable or delete your own account.') : null, pnote.el, saveBtn);

    // password reset
    const wnote = notice();
    const newPass = h('input', { type: 'password', minlength: '8', autocomplete: 'new-password', placeholder: 'New password' });
    const wbtn = h('button', { class: 'btn', type: 'submit' }, 'Set new password');
    const pwForm = h('form', { class: 'form inline', onsubmit: async (e) => {
      e.preventDefault();
      const ok = await run(wbtn, wnote, async () => { await post(`/api/admin/users/${u.id}/password`, { password: newPass.value }); return true; });
      if (ok) { newPass.value = ''; wnote.show(self ? 'Password changed.' : 'Password changed. They have been signed out everywhere.'); }
    } }, newPass, wbtn, wnote.el);

    // sessions / delete
    const signOutBtn = h('button', { class: 'btn small', onclick: async (e) => {
      if (await run(e.target, wnote, async () => { await del(`/api/admin/users/${u.id}/sessions`); return true; })) wnote.show(`Signed out of ${u.sessions} session(s).`);
    } }, `Sign out everywhere (${u.sessions})`);
    const deleteBtn = h('button', { class: 'btn danger small', disabled: self, onclick: async (e) => {
      if (!confirm(`Delete ${u.displayName} (@${u.username})? Their r_flix account is removed. Their watch history stays in Jellyfin.`)) return;
      if (await run(e.target, pnote, async () => { await del(`/api/admin/users/${u.id}`); return true; })) { editing = null; await load(); }
    } }, 'Delete user');

    return h('section', { class: 'panel user-editor' },
      h('div', { class: 'row-between' }, h('h3', null, `${u.displayName} (@${u.username})`), h('button', { class: 'btn small', onclick: () => { editing = null; draw(); } }, 'Close')),
      h('h4', null, 'Profile'), profile,
      h('h4', null, 'Password'), pwForm,
      h('h4', null, 'Jellyfin accounts (watch history)'), mappings(u),
      h('h4', null, 'Access'), h('div', { class: 'btn-row' }, signOutBtn, deleteBtn));
  }

  /** One dropdown per server: which Jellyfin user is this person? Blank = share the default user's history. */
  function mappings(u) {
    const box = h('div', { class: 'mappings' }, h('p', { class: 'muted' }, 'Loading Jellyfin users…'));
    const mnote = notice();
    const selects = new Map(); // slot -> <select>
    Promise.allSettled(servers.filter((s) => s.enabled && !s.problem).map(async (s) => [s, (await get(`/api/admin/servers/${s.slot}/users`)).users])).then((results) => {
      box.replaceChildren();
      if (!servers.length) box.append(h('p', { class: 'muted' }, 'Add a server first.'));
      for (const [i, s] of servers.filter((x) => x.enabled && !x.problem).entries()) {
        const r = results[i];
        const sel = h('select', { disabled: r.status !== 'fulfilled' });
        sel.append(h('option', { value: '' }, 'Shared (the server\'s default user)'));
        if (r.status === 'fulfilled') {
          for (const ju of r.value[1]) sel.append(h('option', { value: ju.id, selected: u.mappings[s.slot] === ju.id }, `${ju.name}${ju.isAdmin ? ' (admin)' : ''}${ju.isDisabled ? ' (disabled)' : ''}`));
          selects.set(s.slot, sel);
        }
        box.append(field(s.name, sel, r.status === 'rejected' ? 'Cannot list this server\'s users with its saved credentials (use an API key or an administrator login).' : null));
      }
      const save = h('button', { class: 'btn', onclick: async (e) => {
        const body = Object.fromEntries([...selects].map(([slot, sel]) => [slot, sel.value || null]));
        const r = await run(e.target, mnote, () => put(`/api/admin/users/${u.id}/mappings`, { mappings: body }));
        if (r) { mnote.show('Saved.'); u.mappings = r.mappings; }
      } }, 'Save links');
      const auto = h('button', { class: 'btn', onclick: async (e) => {
        const r = await run(e.target, mnote, () => post(`/api/admin/users/${u.id}/automatch`));
        if (!r) return;
        u.mappings = r.user.mappings;
        for (const [slot, sel] of selects) sel.value = r.user.mappings[slot] || '';
        mnote.show(r.results.map((x) => `${x.server}: ${x.matched ? `linked to ${x.matched}` : x.error || `no Jellyfin user named "${u.username}"`}`).join(' · '));
      } }, `Link by username (@${u.username})`);
      box.append(h('div', { class: 'btn-row' }, save, auto), mnote.el);
    });
    return box;
  }

  await load();
  return undefined;
}
