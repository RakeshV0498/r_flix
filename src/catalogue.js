/**
 * The unified catalogue.
 *
 * Each server's movie/series list is fetched in parallel and cached. The
 * per-server lists are then merged into "groups": one group per distinct title,
 * holding one "variant" per server that has a copy. Titles are matched by
 * provider ids (TMDB / IMDb / TVDB); see dedupeKeys().
 *
 * The browser only sees "cards" (serialised groups) addressed by uid (ids.js).
 * Whichever variant is on a reachable server, in config priority order, is the
 * one used for metadata, artwork and playback.
 */
import { encodeUid, decodeUid, cleanId } from './ids.js';

const TICKS_PER_MIN = 600_000_000;
const PAGE = 200; // small pages keep peak memory low on a 1 GB Pi
const OVERVIEW_MAX = 300; // the library cache keeps a short synopsis; the title page fetches the full text
const EP_CACHE_MAX = 6;
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

// ------------------------------------------------------------------- catalogue

export class Catalogue {
  /** @param {import('./jellyfin.js').JellyfinServer[]} servers */
  constructor(servers, cfg) {
    this.servers = servers;
    this.cfg = cfg;
    this.libs = new Map(); // server index -> { items, fetchedAt }
    this.loading = new Map(); // server index -> in-flight promise
    this.groups = [];
    this.byUid = new Map();
    this.byServerId = new Map(); // "s:jellyfinId" -> group
    this.epCache = new Map(); // series uid -> { at, data }
    this.timer = null;
    this.queue = Promise.resolve(); // library loads run one at a time to keep memory low

    for (const srv of servers) {
      // When a server comes back, pull its library immediately.
      srv.on('online', () => this.loadServer(srv.index));
    }
  }

  /** Initial load + periodic refresh. */
  start() {
    for (const srv of this.servers) this.loadServer(srv.index);
    this.timer = setInterval(() => this.refreshAll(), this.cfg.cacheTtlSeconds * 1000);
    this.timer.unref();
  }

  refreshAll() {
    return Promise.allSettled(this.servers.filter((s) => s.online !== false).map((s) => this.loadServer(s.index)));
  }

  /** Wait (bounded) for servers that have never loaded, so the first request isn't empty. */
  async ensureLoaded() {
    const pending = [...this.loading.entries()].filter(([i]) => !this.libs.has(i)).map(([, p]) => p);
    if (pending.length) {
      await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, this.cfg.requestTimeoutMs + 1000))]);
    }
  }

  /** Fetch one server's whole movie/series list. Keeps the old copy if this fails. */
  loadServer(index) {
    if (this.loading.has(index)) return this.loading.get(index);
    const srv = this.servers[index];
    const p = (this.queue = this.queue.then(async () => {
      try {
        const items = [];
        for (let start = 0; ; start += PAGE) {
          const page = await srv.libraryPage(start, PAGE);
          for (const it of page?.Items || []) items.push(slim(it, index));
          if (!page?.Items?.length || start + PAGE >= (page.TotalRecordCount ?? 0)) break;
        }
        this.libs.set(index, { items, fetchedAt: Date.now() });
        this.rebuild();
      } catch (err) {
        console.warn(`[catalogue] ${srv.name}: library fetch failed: ${err.message}` + (this.libs.has(index) ? ' (using cached copy)' : ''));
      } finally {
        this.loading.delete(index);
      }
    }));
    this.loading.set(index, p);
    return p;
  }

  rebuild() {
    const libs = [...this.libs.entries()].sort(([a], [b]) => a - b).map(([s, l]) => ({ s, items: l.items }));
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
    return this.servers[s]?.online !== false;
  }

  /** The variant to use right now: first (highest priority) on a reachable server. */
  pick(group) {
    return group.variants.find((v) => this.isUp(v.s)) || group.variants[0];
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
      servers: group.variants.map((x) => this.servers[x.s].name),
    };
  }

  // ----------------------------------------------------------------- catalogue views

  /** Home page: hero + rows. */
  async home() {
    await this.ensureLoaded();
    const byAdded = [...this.groups].sort((a, b) => maxAdded(b) - maxAdded(a));
    const byRating = (arr) => [...arr].sort((a, b) => (this.pick(b).item.rating || 0) - (this.pick(a).item.rating || 0));
    const movies = this.groups.filter((g) => g.type === 'Movie');
    const shows = this.groups.filter((g) => g.type === 'Series');

    const rows = [];
    const add = (id, title, kind, groups, extra = {}) => {
      const items = groups.slice(0, 30).map((g) => this.card(g));
      if (items.length) rows.push({ id, title, kind, items, ...extra });
    };

    const cont = await this.continueWatching();
    if (cont.length) rows.push({ id: 'continue', title: 'Continue Watching', kind: 'landscape', items: cont });
    add('recent', 'Recently Added', 'poster', byAdded);
    add('movies', 'Movies', 'poster', byRating(movies), { more: '#/movies' });
    add('shows', 'TV Shows', 'poster', byRating(shows), { more: '#/shows' });

    // A few genre rows, biggest genres first.
    const counts = new Map();
    for (const g of this.groups) for (const genre of this.pick(g).item.genres) counts.set(genre, (counts.get(genre) || 0) + 1);
    [...counts.entries()]
      .filter(([, n]) => n >= 6)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .forEach(([genre]) => add(`genre-${genre}`, genre, 'poster', byAdded.filter((g) => this.pick(g).item.genres.includes(genre))));

    return { featured: this.featured(byAdded), rows };
  }

  /** Hero title: rotates hourly among the newest titles that have a backdrop and a synopsis. */
  featured(byAdded) {
    const top = byAdded
      .filter((g) => {
        const v = this.pick(g);
        return this.isUp(v.s) && v.item.hasBackdrop && v.item.overview;
      })
      .slice(0, 20);
    if (!top.length) return null;
    const hour = Math.floor(Date.now() / 3_600_000);
    return this.card(top[hour % top.length]);
  }

  /**
   * "Continue Watching": resume points + next-up episodes from every reachable
   * server, merged so a title partly watched on both servers shows once.
   */
  async continueWatching(limit = 20) {
    await this.ensureLoaded();
    const per = await Promise.allSettled(
      this.servers.map(async (srv) => {
        if (srv.online === false) return [];
        const [resume, next] = await Promise.allSettled([srv.resume(limit), srv.nextUp(limit)]);
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
          const eps = series && (await this.episodesOf(series).catch(() => null));
          const ep = eps?.byKey.get(`${item.season}:${item.number}`);
          group = ep?.group;
          key = ep?.group.uid;
        }
        if (!group) {
          // Not (yet) in the catalogue, e.g. library not refreshed: show it as a lone variant.
          group = { type: item.type, variants: [{ s: srv.index, id: item.id, item }], uid: encodeUid([{ s: srv.index, id: item.id }]) };
          key = group.uid;
        }
        // Next-up episodes of a series already in progress are redundant with its resume point
        // but a series fully caught up only appears here, so keep both and let sorting decide.
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
  browse({ type, genre, sort = 'added', offset = 0, limit = 60 }) {
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
    return { total: list.length, genres, items: list.slice(offset, offset + limit).map((g) => this.card(g)) };
  }

  /** Search the merged catalogue (titles, then genres). Runs locally, so it works with a server offline. */
  search(q, limit = 60) {
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
    return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, g]) => this.card(g));
  }

  // ------------------------------------------------------------ episodes & details

  /**
   * All episodes of a series, merged across every reachable server that has it.
   * Episodes are matched on season + episode number.
   * @returns {{seasons:object[], flat:object[], byKey:Map}}
   */
  async episodesOf(group) {
    const hit = this.epCache.get(group.uid);
    if (hit && Date.now() - hit.at < 20_000) return hit.data;

    const live = group.variants.filter((v) => this.isUp(v.s));
    const lists = await Promise.allSettled(live.map(async (v) => ({ v, items: await this.servers[v.s].episodes(v.id) })));
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
        e.variants.sort((a, b) => a.s - b.s);
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
    this.epCache.set(group.uid, { at: Date.now(), data });
    return data;
  }

  /** Full details for the title page. Live-fetched so watch state is current. */
  async details(uid) {
    const group = this.groupFor(uid);
    if (!group) return null;
    const live = group.variants.filter((v) => this.isUp(v.s));
    const fetched = await Promise.allSettled(live.map((v) => this.servers[v.s].item(v.id)));
    const items = fetched.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
    const uds = items.map((it) => slimUd(it.UserData));
    const full = items[0]; // highest-priority reachable copy
    const card = this.card(group, uds.length ? mergeUd(uds) : undefined);
    const state = uds.length ? mergeUd(uds) : mergeUd(group.variants.map((v) => v.item.ud));
    const people = full?.People || [];
    return {
      ...card,
      overview: full?.Overview || card.overview,
      tagline: full?.Taglines?.[0] || null,
      studios: (full?.Studios || []).map((s) => s.Name).slice(0, 3),
      cast: people.filter((p) => p.Type === 'Actor').slice(0, 12).map((p) => ({ name: p.Name, role: p.Role || null })),
      directors: people.filter((p) => p.Type === 'Director').map((p) => p.Name).slice(0, 3),
      resumeSeconds: !state.played && state.pos > 0 ? Math.floor(state.pos / 1e7) : 0,
    };
  }
}

const maxAdded = (g) => Math.max(...g.variants.map((v) => v.item.added));
