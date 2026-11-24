/** "My account": display name, password, sign out. */
import { h } from './util.js';
import { put, post } from './api.js';
import { field, notice, run } from './ui.js';

export async function mount(root, { user, onUser, onSignOut }) {
  const nameNote = notice();
  const name = h('input', { type: 'text', value: user.displayName, maxlength: '60' });
  const nameBtn = h('button', { class: 'btn', type: 'submit' }, 'Save name');
  const nameForm = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const me = await run(nameBtn, nameNote, () => put('/api/me', { displayName: name.value }));
    if (me) { onUser(me); nameNote.show('Saved.'); }
  } }, field('Display name', name), nameNote.el, nameBtn);

  const pwNote = notice();
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const next2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const pwBtn = h('button', { class: 'btn', type: 'submit' }, 'Change password');
  const pwForm = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    if (next.value !== next2.value) return pwNote.show('The new passwords do not match.', 'error');
    const done = await run(pwBtn, pwNote, async () => { await post('/api/me/password', { current: cur.value, next: next.value }); return true; });
    if (done) { pwForm.reset(); pwNote.show('Password changed. Other devices have been signed out.'); }
  } }, field('Current password', cur), field('New password', next, 'At least 8 characters'), field('Repeat new password', next2), pwNote.el, pwBtn);

  root.replaceChildren(h('div', { class: 'page narrow' },
    h('h1', null, 'My account'),
    h('p', { class: 'muted' }, `Signed in as ${user.username} · ${user.role === 'admin' ? 'Administrator' : 'Member'}`),
    h('section', { class: 'panel' }, h('h2', null, 'Profile'), nameForm),
    h('section', { class: 'panel' }, h('h2', null, 'Password'), pwForm),
    h('section', { class: 'panel' }, h('button', { class: 'btn', onclick: onSignOut }, 'Sign out'))));
}
