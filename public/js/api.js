/** Thin wrappers around the r_flix backend. The browser never talks to Jellyfin directly. */

export async function get(path, { signal } = {}) {
  let res;
  try {
    res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Cannot reach r_flix. Check that the app is running.');
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* not JSON */
    }
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/** URL of proxied artwork. kind: Primary | Backdrop | Logo | Landscape */
export const img = (uid, kind, width) => `/api/img/${uid}/${kind}?w=${width}`;

/** Where does clicking a card go? Episodes play; titles open their page. */
export const hrefFor = (item, { play = false } = {}) =>
  item.type === 'Episode' || (play && item.type === 'Movie') ? `#/watch/${item.id}` : `#/title/${item.id}`;
