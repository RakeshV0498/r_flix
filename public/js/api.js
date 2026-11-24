/**
 * Thin wrappers around the r_flix backend. The browser never talks to Jellyfin directly.
 * Authentication is a cookie, so there are no tokens to manage here. A 401 from any call
 * (other than the login/setup calls themselves) means the session ended: we tell the app
 * via an "rflix:unauthorized" event so it can show the sign-in page.
 */

async function request(method, path, { body, signal, quiet401 = false } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Cannot reach r_flix. Check that the app is running.');
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    if (res.status === 401 && !quiet401) dispatchEvent(new CustomEvent('rflix:unauthorized'));
    const e = new Error(data?.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

export const get = (path, opts) => request('GET', path, opts);
export const post = (path, body, opts) => request('POST', path, { ...opts, body: body ?? {} });
export const put = (path, body, opts) => request('PUT', path, { ...opts, body: body ?? {} });
export const del = (path, opts) => request('DELETE', path, opts);

/** URL of proxied artwork. kind: Primary | Backdrop | Logo | Landscape */
export const img = (uid, kind, width) => `/api/img/${uid}/${kind}?w=${width}`;

/** Where does clicking a card go? Episodes play; titles open their page. */
export const hrefFor = (item, { play = false } = {}) =>
  item.type === 'Episode' || (play && item.type === 'Movie') ? `#/watch/${item.id}` : `#/title/${item.id}`;
