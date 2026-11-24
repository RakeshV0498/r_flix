/** Sign-in and first-run setup screens (shown instead of the app until you are signed in). */
import { h } from './util.js';
import { post } from './api.js';
import { field, notice, run } from './ui.js';

function shell(title, subtitle, ...children) {
  return h('div', { class: 'auth-page' }, h('div', { class: 'auth-card' },
    h('div', { class: 'auth-logo' }, 'R_FLIX'), h('h1', null, title), subtitle ? h('p', { class: 'auth-sub' }, subtitle) : null, ...children));
}

/** @param {{message?:string, onDone:(user:object)=>void}} opts */
export function mountLogin(root, { message, onDone }) {
  const note = notice();
  if (message) note.show(message, 'error');
  const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, 'data-autofocus': '' });
  const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn primary wide', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const me = await run(btn, note, () => post('/api/auth/login', { username: user.value.trim(), password: pass.value }, { quiet401: true }));
    if (me) onDone(me);
    else pass.select();
  } }, field('Username', user), field('Password', pass), note.el, btn);
  root.replaceChildren(shell('Sign in', 'Welcome back.', form));
  user.focus();
}

/** First run: no accounts exist yet. The setup code is printed in the server log. */
export function mountSetup(root, { onDone }) {
  const note = notice();
  const code = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', required: true, placeholder: 'e.g. 3f9a1c7e' });
  const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, minlength: '3', maxlength: '32' });
  const name = h('input', { type: 'text', autocomplete: 'name', maxlength: '60' });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const pass2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const btn = h('button', { class: 'btn primary wide', type: 'submit' }, 'Create administrator');
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    if (pass.value !== pass2.value) return note.show('The two passwords do not match.', 'error');
    const me = await run(btn, note, () => post('/api/setup', { code: code.value.trim(), username: user.value.trim(), displayName: name.value.trim(), password: pass.value }, { quiet401: true }));
    if (me) onDone(me);
  } },
    field('Setup code', code, 'Shown in the r_flix log when it starts: run  docker compose logs r_flix'),
    field('Username', user, '3-32 characters: letters, numbers, . _ -'),
    field('Display name (optional)', name),
    field('Password', pass, 'At least 8 characters'),
    field('Repeat password', pass2),
    note.el, btn);
  root.replaceChildren(shell('Welcome to r_flix', 'Create the administrator account. You will add your Jellyfin servers and other users on the Admin page next.', form));
  code.focus();
}
