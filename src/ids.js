/**
 * Unified item ids.
 *
 * The browser only ever sees a "uid", never a server address or a raw Jellyfin
 * id. A uid is a stateless, reversible encoding of every copy ("variant") of
 * an item across the configured servers:
 *
 *     <serverIndex><32-hex Jellyfin id>[-<serverIndex><32-hex id>...]
 *
 * e.g. "0a1b2...-1c3d4..." means: copy on server 0 and copy on server 1.
 * Being stateless, uids survive a backend restart (bookmarks and page reloads
 * keep working) and need no lookup table.
 */
const PART = /^(\d)([0-9a-f]{32})$/;

/** Jellyfin ids may or may not contain dashes; normalise to 32 lowercase hex. */
export const cleanId = (id) => String(id).replace(/-/g, '').toLowerCase();

/** @param {{s:number,id:string}[]} variants */
export function encodeUid(variants) {
  return variants.map((v) => `${v.s}${cleanId(v.id)}`).join('-');
}

/** @returns {{s:number,id:string}[]|null} null when the uid is malformed */
export function decodeUid(uid) {
  if (typeof uid !== 'string' || uid.length > 9 * 34) return null;
  const out = [];
  for (const part of uid.split('-')) {
    const m = PART.exec(part);
    if (!m) return null;
    out.push({ s: Number(m[1]), id: m[2] });
  }
  return out.length ? out : null;
}
