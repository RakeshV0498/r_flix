/** Small form/feedback helpers shared by the sign-in, account and admin pages. */
import { h } from './util.js';

/** A labelled form control with optional help text. */
export function field(label, control, help) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, help ? h('span', { class: 'help' }, help) : null);
}

/** A checkbox row. */
export function check(label, checked, help) {
  const input = h('input', { type: 'checkbox', checked: !!checked });
  return { input, el: h('label', { class: 'check' }, input, h('span', null, label), help ? h('span', { class: 'help' }, help) : null) };
}

/** An inline message area: show('Saved', 'ok') / show('Nope', 'error') / clear(). */
export function notice() {
  const el = h('p', { class: 'notice-line', role: 'status', hidden: true });
  return {
    el,
    show(text, kind = 'ok') {
      el.textContent = text;
      el.className = `notice-line ${kind}`;
      el.hidden = false;
    },
    clear() {
      el.hidden = true;
    },
  };
}

/**
 * Run an async action with the button disabled; report errors in `note`.
 * Resolves to the action's result, or undefined if it failed.
 */
export async function run(button, note, fn) {
  button.disabled = true;
  note?.clear();
  try {
    return await fn();
  } catch (err) {
    note?.show(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

export const date = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
