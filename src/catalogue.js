/**
 * The unified catalogue.
 *
 * Each server's movie/series list is fetched and cached (one server at a time, to keep memory
 * low on a Pi). The per-server lists are merged into "groups": one group per distinct title,
 * holding one "variant" per server that has a copy. Titles are matched by provider ids
 * (TMDB / IMDb / TVDB); see dedupeKeys().
 *
 * The LIBRARY (what titles exist) is shared and built from each server's default user. WATCH
 * STATE (played, progress, Continue Watching) is per r_flix user: each user can be mapped to a
 * Jellyfin user on every server, and their own state is fetched live and overlaid on the cards.
 * A user with no mapping on a server shares that server's default user's history.
 *
 * The browser only sees "cards" (serialised groups) addressed by uid (ids.js). Whichever variant
 * is on a reachable server, in priority order, is the one used for metadata, artwork and playback.
 */
import { encodeUid, decodeUid, cleanId } from './ids.js';

const TICKS_PER_MIN = 600_000_000;
const PAGE = 200; // small pages keep peak memory low on a 1 GB Pi
const OVERVIEW_MAX = 300; // the library cache keeps a short synopsis; the title page fetches the full text
const EP_CACHE_MAX = 12;
const PROVIDERS = ['tmdb', 'imdb', 'tvdb'];

// ------------------------------------------------------------------ pure helpers

/** Reduce a Jellyfin BaseItemDto to the few fields we keep in memory. */
export function slim(it, s, { fullOverview = false } = {}) {
  const ud = it.UserData || {};
  return {
    s,
    id: cleanId(it.Id),
    type: it.Type,
    name: it.Name || '',
    sortName: (it.SortName || it.Name || '').toLowerCase(),
    year: it.ProductionYear || null,
    overview: fullOverview ? it.Overview || '' : (it.Overview || '').slice(0, OVERVIEW_MAX),
    genres: it.Genres || [],
    rating: it.CommunityRating || null,
    officialRating: it.OfficialRating || null,
    runtimeTicks: it.RunTimeTicks || 0,
    added: Date.parse(it.DateCreated) || 0,
    providers: Object.fromEntries(Object.entries(it.ProviderIds || {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
    hasPoster: !!it.ImageTags?.Primary,
    hasBackdrop: (it.BackdropImageTags?.length || 0) > 0,
    hasLogo: !!it.ImageTags?.Logo,
    // episodes only
    seriesId: it.SeriesId ? cleanId(it.SeriesId) : null,
    seriesName: it.SeriesName || null,
    season: it.ParentIndexNumber ?? null,
    number: it.IndexNumber ?? null,
    ud: slimUd(ud),
  };
}

export function slimUd(ud = {}) {
  return {
    played: !!ud.Played,
    pos: ud.PlaybackPositionTicks || 0,
    last: Date.parse(ud.LastPlayedDate) || 0,
    unplayed: ud.UnplayedItemCount ?? null,
  };
}

/**
 * Combine the watch state of the same title on several servers.
 * The most recently played copy wins, so finishing a film on server B
 * overrides a stale half-watched marker on server A.
 */
export function mergeUd(list) {
  const uds = list.filter(Boolean);
  if (!uds.length) return { played: false, pos: 0, last: 0, unplayed: null };
  const dated = uds.filter((u) => u.last > 0);
  if (dated.length) return dated.reduce((a, b) => (b.last > a.last ? b : a));
  return {
    played: uds.some((u) => u.played),
    pos: Math.max(...uds.map((u) => u.pos || 0)),
    last: 0,
    unplayed: uds.find((u) => u.unplayed != null)?.unplayed ?? null,
  };
}

const normTitle = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Identity keys for duplicate detection. Two items are the same title if they
 * share ANY key. The item type is part of every key because TMDB ids are only
 * unique per type (movie 603 is not series 603).
 */
export function dedupeKeys(item, fallbackToTitleYear = true) {
  const keys = [];
  for (const p of PROVIDERS) if (item.providers[p]) keys.push(`${item.type}:${p}:${item.providers[p].toLowerCase()}`);
  if (!keys.length && fallbackToTitleYear && item.name) keys.push(`${item.type}:title:${normTitle(item.name)}|${item.year ?? ''}`);
  return keys;
}

/**
 * Merge per-server item lists into groups of duplicates.
 * @param {{s:number, items:object[]}[]} libs  in server priority order
 * @returns {{type:string, variants:{s:number,id:string,item:object}[], uid:string}[]}
 */
export function mergeLibraries(libs, { fallbackToTitleYear = true } = {}) {
  const groups = [];
  const keyToGroup = new Map();
  for (const { s, items } of libs) {
    for (const item of items) {
      const keys = dedupeKeys(item, fallbackToTitleYear);
      // An item never merges with another copy from its OWN server: that is
      // that server's business (e.g. two distinct editions), not a duplicate.
      const hits = new Set();
      for (const k of keys) {
        const g = keyToGroup.get(k);
        if (g && !g.variants.some((v) => v.s === s)) hits.add(g);
      }
      let g;
      if (hits.size === 0) {
        g = { type: item.type, variants: [], keys: new Set() };
        groups.push(g);
      } else {
        [g] = hits;
      }
      g.variants.push({ s, id: item.id, item });
      for (const k of keys) {
        g.keys.add(k);
        if (!keyToGroup.has(k)) keyToGroup.set(k, g);
      }
    }
  }
  for (const g of groups) g.uid = encodeUid(g.variants);
  return groups;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const maxAdded = (g) => Math.max(...g.variants.map((v) => v.item.added));

// ------------------------------------------------------------------- catalogue

/**
 * @typedef {{id:number, map:Record<number,string>}} UserCtx  the signed-in r_flix user and
 *   their Jellyfin user id per server slot (set by the auth middleware)
 */
export class Catalogue {
  /**
   * @param {import('./servers.js').ServerRegistry} registry
   * @param {import('./settings.js').Settings} settings
   */
  constructor(registry, settings) {
    this.reg = registry;
    this.settings = settings;
    this.libs = new Map(); // server slot -> { items, fetchedAt }
    this.loading = new Map(); // server slot -> in-flight promise
    this.groups = [];
    this.byUid = new Map();
    this.byServerId = new Map(); // "slot:jellyfinId" -> group
    this.epCache = new Map(); // "seriesUid|userId" -> { at, data }
    this.timer = null;
    this.queue = Promise.resolve(); // library loads run one at a time to keep memory low

    // React to admin changes and server recoveries.
    registry.on('serverOnline', (slot) => this.loadServer(slot));
    registry.on('changed', ({ type, slot, reload }) => {
      if (type === 'removed') this.dropServer(slot);
      else if (type === 'reordered') this.rebuild();
      else if (reload) {
        this.libs.delete(slot); // credentials/URL changed: the old list may belong to another server
        this.rebuild();
        this.loadServer(slot);
      }
    });
    settings.on('change', (keys) => {
      if (keys.includes('cacheTtlSeconds')) this.schedule();
      if (keys.includes('dedupe.fallbackToTitleYear')) this.rebuild();
    });
  }

  get cfg() {
    return this.settings.values;
  }

  /** Initial load + periodic refresh. */
  start() {
    for (const srv of this.reg.list()) this.loadServer(srv.index);
    this.schedule();
  }

  schedule() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refreshAll(), this.cfg.cacheTtlSeconds * 1000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  refreshAll() {
    return Promise.allSettled(this.reg.list().filter((s) => s.online !== false).map((s) => this.loadServer(s.index)));
  }

  /** Wait (bounded) for servers that have never loaded, so the first request isn't empty. */
  async ensureLoaded() {
    const pending = [...this.loading.entries()].filter(([i]) => !this.libs.has(i)).map(([, p]) => p);
    if (pending.length) {
      await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, this.cfg.requestTimeoutMs + 1000))]);
    }
  }

  /** Fetch one server's whole movie/series list. Keeps the old copy if this fails. */
  loadServer(slot) {
    if (this.loading.has(slot)) return this.loading.get(slot);
    const p = (this.queue = this.queue.then(async () => {
      const srv = this.reg.get(slot);
      let replaced = false;
      try {
        if (!srv) return;
        const items = [];
        for (let start = 0; ; start += PAGE) {
          const page = await srv.libraryPage(start, PAGE);
          for (const it of page?.Items || []) items.push(slim(it, slot));
          if (!page?.Items?.length || start + PAGE >= (page.TotalRecordCount ?? 0)) break;
        }
        if (this.reg.get(slot) !== srv) {
          replaced = true; // edited or removed while we were fetching: this list is stale
          return;
        }
        this.libs.set(slot, { items, fetchedAt: Date.now() });
        this.rebuild();
      } catch (err) {
        console.warn(`[catalogue] ${srv?.name ?? `slot ${slot}`}: library fetch failed: ${err.message}` + (this.libs.has(slot) ? ' (using cached copy)' : ''));
      } finally {
        this.loading.delete(slot);
        if (replaced && this.reg.get(slot)) queueMicrotask(() => this.loadServer(slot)); // fetch from the new connection
      }
    }));
    this.loading.set(slot, p);
    return p;
  }

  dropServer(slot) {
    this.libs.delete(slot);
    this.rebuild();
  }

  rebuild() {
    const libs = [...this.libs.entries()]
      .filter(([s]) => this.reg.get(s)) // servers that were removed/disabled drop out
      .sort(([a], [b]) => this.reg.rank(a) - this.reg.rank(b))
      .map(([s, l]) => ({ s, items: l.items }));
    this.groups = mergeLibraries(libs, { fallbackToTitleYear: this.cfg.dedupe.fallbackToTitleYear });
    this.byUid = new Map();
    this.byServerId = new Map();
    for (const g of this.groups) {
      this.byUid.set(g.uid, g);
      for (const v of g.variants) this.byServerId.set(`${v.s}:${v.id}`, g);
    }
    this.epCache.clear();
  }

  /** Find a group by uid, tolerating a uid whose variant set has since changed. */
  groupFor(uid) {
    const direct = this.byUid.get(uid);
    if (direct) return direct;
    for (const v of decodeUid(uid) || []) {
      const g = this.byServerId.get(`${v.s}:${v.id}`);
      if (g) return g;
    }
    return null;
  }

  isUp(s) {
    const srv = this.reg.get(s);
    return !!srv && srv.online !== false;
  }

  /** The variant to use right now: first (highest priority) on a reachable server. */
  pick(group) {
    return group.variants.find((v) => this.isUp(v.s)) || group.variants[0];
  }

  // ------------------------------------------------------------- per-user state

  /** The Jellyfin user to act as on `slot` for this r_flix user (undefined = server's default user). */
  jfUser(user, slot) {
    return user?.map?.[slot] || undefined;
  }

  hasMappings(user) {
    return !!user && Object.keys(user.map || {}).length > 0;
  }

  /**
   * Fetch this user's own watch state for the given groups (one request per server).
   * Users with no Jellyfin mapping skip this and use the cached default-user state.
   * @returns {Promise<Map<string, object>|null>} uid -> merged state, or null when not needed
   */
  async overlay(user, groups) {
    if (!this.hasMappings(user) || !groups.length) return null;
    const bySlot = new Map();
    for (const g of groups) for (const v of g.variants) if (this.isUp(v.s)) (bySlot.get(v.s) || bySlot.set(v.s, []).get(v.s)).push(v.id);
    const states = new Map(); // "slot:id" -> state
    await Promise.allSettled(
      [...bySlot].map(async ([slot, ids]) => {
        const m = await this.reg.get(slot).userStates(ids, this.jfUser(user, slot));
        for (const [id, ud] of m) states.set(`${slot}:${id}`, slimUd(ud));
      }),
    );
    const out = new Map();
    for (const g of groups) {
      out.set(
        g.uid,
        mergeUd(g.variants.map((v) => states.get(`${v.s}:${v.id}`) ?? (this.jfUser(user, v.s) ? undefined : v.item.ud))),
      );
    }
    return out;
  }

  // --------------------------------------------------------------- serialisation

  /** Serialise a group (or episode entry) to the JSON the front end consumes. */
  card(group, ud) {
    const v = this.pick(group);
    const m = v.item;
    const state = ud ?? mergeUd(group.variants.map((x) => x.item.ud));
    const isEp = m.type === 'Episode';
    return {
      id: group.uid,
      type: m.type,
      title: isEp ? m.seriesName || m.name : m.name,
      subtitle: isEp ? `S${m.season ?? '?'}:E${m.number ?? '?'} · ${m.name}` : null,
      year: m.year,
      rating: m.rating ? Math.round(m.rating * 10) / 10 : null,
      officialRating: m.officialRating,
      runtime: m.runtimeTicks ? Math.round(m.runtimeTicks / TICKS_PER_MIN) : null,
      overview: m.overview,
      genres: m.genres,
      progress: !state.played && state.pos > 0 && m.runtimeTicks ? clamp((state.pos / m.runtimeTicks) * 100, 0, 100) : null,
      played: state.played,
      unplayed: state.unplayed,
      poster: m.hasPoster,
      backdrop: m.hasBackdrop,
      logo: m.hasLogo,
      available: group.variants.some((x) => this.isUp(x.s)),
      servers: group.variants.map((x) => this.reg.get(x.s)?.name ?? '?'),
    };
  }

  /** Cards for a list of groups, with the user's own watch state applied. */
  async cards(user, groups) {
    const ov = await this.overlay(user, groups);
    return groups.map((g) => this.card(g, ov?.get(g.uid)));
  }

  // ----------------------------------------------------------------- catalogue views

  /** Home page: hero + rows. */
  async home(user) {
    await this.ensureLoaded();
    const byAdded = [...this.groups].sort((a, b) => maxAdded(b) - maxAdded(a));
    const byRating = (arr) => [...arr].sort((a, b) => (this.pick(b).item.rating || 0) - (this.pick(a).item.rating || 0));
    const movies = this.groups.filter((g) => g.type === 'Movie');
    const shows = this.groups.filter((g) => g.type === 'Series');

    const defs = []; // [id, title, kind, groups, extra]
    defs.push(['recent', 'Recently Added', 'poster', byAdded.slice(0, 30), {}]);
    defs.push(['movies', 'Movies', 'poster', byRating(movies).slice(0, 30), { more: '#/movies' }]);
    defs.push(['shows', 'TV Shows', 'poster', byRating(shows).slice(0, 30), { more: '#/shows' }]);
    // A few genre rows, biggest genres first.
    const counts = new Map();
    for (const g of this.groups) for (const genre of this.pick(g).item.genres) counts.set(genre, (counts.get(genre) || 0) + 1);
    [...counts.entries()]
      .filter(([, n]) => n >= 6)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .forEach(([genre]) => defs.push([`genre-${genre}`, genre, 'poster', byAdded.filter((g) => this.pick(g).item.genres.includes(genre)).slice(0, 30), {}]));

    const featuredGroup = this.featuredGroup(byAdded);
    const cont = await this.continueWatching(user);
    // One overlay request per server covers every card on the page.
    const all = [...new Map([...defs.flatMap((d) => d[3]), ...(featuredGroup ? [featuredGroup] : [])].map((g) => [g.uid, g])).values()];
    const ov = await this.overlay(user, all);
    const toCard = (g) => this.card(g, ov?.get(g.uid));

    const rows = [];
    if (cont.length) rows.push({ id: 'continue', title: 'Continue Watching', kind: 'landscape', items: cont });
    for (const [id, title, kind, groups, extra] of defs) if (groups.length) rows.push({ id, title, kind, items: groups.map(toCard), ...extra });
    return { featured: featuredGroup ? toCard(featuredGroup) : null, rows };
  }

  /** Hero title: rotates hourly among the newest titles that have a backdrop and a synopsis. */
  featuredGroup(byAdded) {
    const top = byAdded
      .filter((g) => {
        const v = this.pick(g);
        return this.isUp(v.s) && v.item.hasBackdrop && v.item.overview;
      })
      .slice(0, 20);
    if (!top.length) return null;
    return top[Math.floor(Date.now() / 3_600_000) % top.length];
  }

  /**
   * "Continue Watching" for one user: resume points + next-up episodes from every reachable
   * server, merged so a title partly watched on both servers shows once.
   */
  async continueWatching(user, limit = 20) {
    await this.ensureLoaded();
    const per = await Promise.allSettled(
      this.reg.list().map(async (srv) => {
        if (srv.online === false) return [];
        const jf = this.jfUser(user, srv.index);
        const [resume, next] = await Promise.allSettled([srv.resume(jf, limit), srv.nextUp(jf, limit)]);
        return [
          ...(resume.value || []).map((it) => ({ srv, it, resume: true })),
          ...(next.value || []).map((it) => ({ srv, it, resume: false })),
        ];
      }),
    );
    const entries = per.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

    // Map each entry to a unified group/episode, collecting the fresh watch states.
    const merged = new Map(); // key -> { group, uds[], last, resume }
    await Promise.all(
      entries.map(async ({ srv, it, resume }) => {
        const item = slim(it, srv.index);
        let key, group;
        if (item.type === 'Movie') {
          group = this.byServerId.get(`${srv.index}:${item.id}`);
          key = group?.uid;
        } else if (item.type === 'Episode') {
          const series = item.seriesId && this.byServerId.get(`${srv.index}:${item.seriesId}`);
          const eps = series && (await this.episodesOf(series, user).catch(() => null));
          const ep = eps?.byKey.get(`${item.season}:${item.number}`);
          group = ep?.group;
          key = ep?.group.uid;
        }
        if (!group) {
          // Not (yet) in the catalogue, e.g. library not refreshed: show it as a lone variant.
          group = { type: item.type, variants: [{ s: srv.index, id: item.id, item }], uid: encodeUid([{ s: srv.index, id: item.id }]) };
          key = group.uid;
        }
        const slot = merged.get(key) || { group, uds: [], last: 0, resume: false };
        slot.uds.push(item.ud);
        slot.last = Math.max(slot.last, item.ud.last);
        slot.resume ||= resume;
        merged.set(key, slot);
      }),
    );

    // Resume points first (most recent first), then next-up episodes.
    // A series' next-up is dropped when one of its episodes is already resumable.
    const resumable = new Set();
    for (const slot of merged.values()) if (slot.resume) resumable.add(this.pick(slot.group).item.seriesId);
    return [...merged.values()]
      .filter((x) => x.resume || !resumable.has(this.pick(x.group).item.seriesId))
      .sort((a, b) => Number(b.resume) - Number(a.resume) || b.last - a.last)
      .slice(0, limit)
      .map((x) => this.card(x.group, mergeUd(x.uds)));
  }

  /** Browse grid with filter/sort/paging. */
  async browse(user, { type, genre, sort = 'added', offset = 0, limit = 60 }) {
    let list = this.groups.filter((g) => !type || g.type === type);
    const genres = [...new Set(list.flatMap((g) => this.pick(g).item.genres))].sort();
    if (genre) list = list.filter((g) => this.pick(g).item.genres.includes(genre));
    const m = (g) => this.pick(g).item;
    const sorters = {
      added: (a, b) => maxAdded(b) - maxAdded(a),
      name: (a, b) => m(a).sortName.localeCompare(m(b).sortName),
      year: (a, b) => (m(b).year || 0) - (m(a).year || 0),
      rating: (a, b) => (m(b).rating || 0) - (m(a).rating || 0),
    };
    list = [...list].sort(sorters[sort] || sorters.added);
    return { total: list.length, genres, items: await this.cards(user, list.slice(offset, offset + limit)) };
  }

  /** Search the merged catalogue (titles, then genres). Runs locally, so it works with a server offline. */
  async search(user, q, limit = 60) {
    const term = normTitle(q);
    if (!term) return [];
    const scored = [];
    for (const g of this.groups) {
      const m = this.pick(g).item;
      const name = normTitle(m.name);
      let score = 0;
      if (name === term) score = 100;
      else if (name.startsWith(term)) score = 80;
      else if (name.split(' ').some((w) => w.startsWith(term))) score = 60;
      else if (name.includes(term)) score = 40;
      else if (m.genres.some((x) => normTitle(x) === term)) score = 20;
      else if (String(m.year) === term) score = 15;
      if (score) scored.push([score + (m.rating || 0) / 10, g]);
    }
    return this.cards(user, scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, g]) => g));
  }

  // ------------------------------------------------------------ episodes & details

  /**
   * All episodes of a series, merged across every reachable server that has it, with this
   * user's watch state. Episodes are matched on season + episode number.
   * @returns {{seasons:object[], flat:object[], byKey:Map}}
   */
  async episodesOf(group, user) {
    const cacheKey = `${group.uid}|${user?.id ?? 0}`;
    const hit = this.epCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 20_000) return hit.data;

    const live = group.variants.filter((v) => this.isUp(v.s));
    const lists = await Promise.allSettled(live.map(async (v) => ({ v, items: await this.reg.get(v.s).episodes(v.id, this.jfUser(user, v.s)) })));
    const ok = lists.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!ok.length) throw lists.find((r) => r.status === 'rejected')?.reason || new Error('No server reachable for this series');

    const eps = new Map(); // "season:number" -> { variants: [] }
    for (const { v, items } of ok) {
      for (const raw of items) {
        const item = slim(raw, v.s, { fullOverview: true });
        const key = item.number == null ? `x:${item.id}` : `${item.season ?? 0}:${item.number}`;
        const e = eps.get(key) || { key, variants: [] };
        if (!e.variants.some((x) => x.s === v.s)) e.variants.push({ s: v.s, id: item.id, item });
        eps.set(key, e);
      }
    }
    const flat = [...eps.values()]
      .map((e) => {
        e.variants.sort((a, b) => this.reg.rank(a.s) - this.reg.rank(b.s));
        e.uid = encodeUid(e.variants);
        e.type = 'Episode';
        const m = e.variants[0].item;
        e.group = e;
        e.season = m.season ?? 0;
        e.number = m.number;
        return e;
      })
      .sort((a, b) => a.season - b.season || (a.number ?? 1e9) - (b.number ?? 1e9));

    const bySeason = new Map();
    for (const e of flat) {
      if (!bySeason.has(e.season)) bySeason.set(e.season, []);
      bySeason.get(e.season).push(e);
    }
    const seasons = [...bySeason.entries()].map(([number, list]) => ({
      number,
      name: number === 0 ? 'Specials' : `Season ${number}`,
      episodes: list.map((e) => {
        const m = e.variants.find((v) => this.isUp(v.s))?.item || e.variants[0].item;
        const ud = mergeUd(e.variants.map((v) => v.item.ud));
        return {
          id: e.uid,
          number: e.number,
          season: e.season,
          title: m.name,
          overview: m.overview,
          runtime: m.runtimeTicks ? Math.round(m.runtimeTicks / TICKS_PER_MIN) : null,
          thumb: m.hasPoster,
          played: ud.played,
          progress: !ud.played && ud.pos > 0 && m.runtimeTicks ? clamp((ud.pos / m.runtimeTicks) * 100, 0, 100) : null,
          available: e.variants.some((v) => this.isUp(v.s)),
        };
      }),
    }));
    const data = { seasons, flat, byKey: new Map(flat.map((e) => [e.key, e])) };
    if (this.epCache.size >= EP_CACHE_MAX) this.epCache.delete(this.epCache.keys().next().value);
    this.epCache.set(cacheKey, { at: Date.now(), data });
    return data;
  }

  /** Full details for the title page. Live-fetched so this user's watch state is current. */
  async details(uid, user) {
    const group = this.groupFor(uid);
    if (!group) return null;
    const live = group.variants.filter((v) => this.isUp(v.s));
    const fetched = await Promise.allSettled(live.map((v) => this.reg.get(v.s).item(v.id, this.jfUser(user, v.s))));
    const items = fetched.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
    const uds = items.map((it) => slimUd(it.UserData));
    const full = items[0]; // highest-priority reachable copy
    const state = uds.length ? mergeUd(uds) : undefined;
    const card = this.card(group, state);
    const people = full?.People || [];
    return {
      ...card,
      overview: full?.Overview || card.overview,
      tagline: full?.Taglines?.[0] || null,
      studios: (full?.Studios || []).map((s) => s.Name).slice(0, 3),
      cast: people.filter((p) => p.Type === 'Actor').slice(0, 12).map((p) => ({ name: p.Name, role: p.Role || null })),
      directors: people.filter((p) => p.Type === 'Director').map((p) => p.Name).slice(0, 3),
      resumeSeconds: state && !state.played && state.pos > 0 ? Math.floor(state.pos / 1e7) : 0,
    };
  }

  /** Numbers for the Admin status tab. */
  stats() {
    const dupes = this.groups.filter((g) => g.variants.length > 1).length;
    return {
      titles: this.groups.length,
      movies: this.groups.filter((g) => g.type === 'Movie').length,
      series: this.groups.filter((g) => g.type === 'Series').length,
      onMultipleServers: dupes,
      servers: this.reg.list().map((s) => {
        const lib = this.libs.get(s.index);
        return { slot: s.index, name: s.name, items: lib?.items.length ?? 0, fetchedAt: lib?.fetchedAt ?? null, loading: this.loading.has(s.index) };
      }),
    };
  }
}
