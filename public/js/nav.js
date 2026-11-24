/**
 * Keyboard / TV-remote navigation.
 *
 * Arrow keys move focus to the nearest focusable element in that direction
 * ("spatial navigation"), so a remote's D-pad works across rows, grids and
 * buttons with no per-page wiring. Enter activates (links/buttons do this
 * natively). Back keys (Esc, Backspace, browser/TV back) go back.
 * The player installs its own capture-phase handler and bypasses this.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

const visible = (el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};

function overlap(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/** Pick the best candidate in `dir` from the current element, or null. */
export function nextFocus(cur, candidates, dir) {
  const a = cur.getBoundingClientRect();
  const horizontal = dir === 'left' || dir === 'right';
  let best = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    let gap, off;
    if (horizontal) {
      if (dir === 'right' ? dx <= 1 : dx >= -1) continue;
      // Stay in the same row: require real vertical overlap.
      if (overlap(a.top, a.bottom, b.top, b.bottom) < Math.min(a.height, b.height) * 0.3) continue;
      gap = dir === 'right' ? Math.max(0, b.left - a.right) : Math.max(0, a.left - b.right);
      off = Math.abs(dy);
    } else {
      if (dir === 'down' ? dy <= 1 : dy >= -1) continue;
      gap = dir === 'down' ? Math.max(0, b.top - a.bottom) : Math.max(0, a.top - b.bottom);
      // Prefer targets lined up horizontally with where we are.
      off = overlap(a.left, a.right, b.left, b.right) > 0 ? Math.abs(dx) * 0.5 : Math.abs(dx) * 2 + 500;
    }
    const score = gap + off * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

export function focusables(root = document) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(visible);
}

export function focusEl(el, dir) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: dir === 'up' || dir === 'down' ? 'center' : 'nearest', inline: 'center', behavior: 'smooth' });
}

const KEY_DIR = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const BACK_KEYS = new Set(['Escape', 'BrowserBack', 'GoBack', 'XF86Back']);
const BACK_CODES = new Set([10009, 461]); // Samsung Tizen, LG webOS

export function initNav({ goBack }) {
  // Show focus rings only after the keyboard/remote is used.
  addEventListener('keydown', () => document.body.classList.add('using-keys'), true);
  addEventListener('pointerdown', () => document.body.classList.remove('using-keys'), true);

  document.addEventListener('keydown', (e) => {
    if (document.body.classList.contains('in-player') || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = e.target instanceof HTMLInputElement && e.target.type !== 'button';

    // "/" jumps to search, like most streaming sites.
    if (e.key === '/' && !typing) {
      e.preventDefault();
      document.getElementById('search').focus();
      return;
    }
    if (BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode) || (e.key === 'Backspace' && !typing)) {
      if (typing && e.key === 'Escape') e.target.blur();
      else {
        e.preventDefault();
        goBack();
      }
      return;
    }

    const dir = KEY_DIR[e.key];
    if (!dir) return;
    // Inside a text box, left/right edit text; up/down leave it.
    if (typing && (dir === 'left' || dir === 'right')) return;
    e.preventDefault();

    const list = focusables();
    const cur = document.activeElement;
    if (!cur || cur === document.body || !list.includes(cur)) {
      const first = list.find((el) => el.getBoundingClientRect().top >= 0) || list[0];
      if (first) focusEl(first, dir);
      return;
    }
    const target = nextFocus(cur, list, dir);
    if (target) focusEl(target, dir);
  });
}
