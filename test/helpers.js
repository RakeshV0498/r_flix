/** Shared test harness: two mock Jellyfin servers + a real r_flix app on an in-memory database. */
import { createMockJellyfin } from '../dev/mock-jellyfin.js';
import { createApp } from '../src/app.js';

export const T = (type, name, tmdb, extra = {}) => ({ type, name, year: 2020, tmdb, genres: ['Drama'], ...extra });
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const waitFor = async (fn, ms = 4000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await wait(50);
  }
  throw new Error('timeout waiting for condition');
};
export const findCard = (rows, title) => rows.flatMap((r) => r.items).find((i) => i.title === title);

/** An HTTP client with a cookie jar, so each instance is one signed-in browser. */
export function makeClient(base) {
  let cookie = '';
  const client = {
    async req(path, init = {}) {
      const headers = { ...(init.headers || {}) };
      if (cookie) headers.cookie = cookie;
      let body = init.body;
      if (init.json !== undefined) {
        body = JSON.stringify(init.json);
        headers['content-type'] = 'application/json';
      }
      const r = await fetch(base + path, { method: init.method || (init.json !== undefined ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
      for (const sc of r.headers.getSetCookie?.() || []) {
        const [pair] = sc.split(';');
        const [k, v] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
        if (k === 'rflix_session') cookie = v && !/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc) ? `${k}=${v}` : '';
      }
      const type = r.headers.get('content-type') || '';
      return { status: r.status, headers: r.headers, body: type.includes('json') ? await r.json() : await r.text() };
    },
    get: (p, init) => client.req(p, init),
    post: (p, json, init) => client.req(p, { ...init, method: 'POST', json }),
    put: (p, json) => client.req(p, { method: 'PUT', json }),
    del: (p) => client.req(p, { method: 'DELETE' }),
    login: (username, password) => client.post('/api/auth/login', { username, password }),
    get cookie() {
      return cookie;
    },
    set cookie(v) {
      cookie = v;
    },
  };
  return client;
}

export const A_TITLES = [T('Movie', 'Shared Film', 1), T('Movie', 'Only On A', 2), T('Series', 'Shared Show', 10), T('Movie', 'Transcoded', 3, { transcode: true })];
export const B_TITLES = [T('Movie', 'Shared Film', 1), T('Movie', 'Only On B', 4), T('Series', 'Shared Show', 10)];

/**
 * Start mocks A (API key) and B (username/password login, legacy routes) and an app that imports
 * them from "legacy config". Admin account `admin` / `correct horse` is created via the setup flow.
 */
export async function bootStack({ legacy = true, mockA = {}, mockB = {} } = {}) {
  const a = createMockJellyfin({
    name: 'A', apiKey: 'key-a', users: ['demo', 'alice', 'bob'], titles: A_TITLES,
    watch: { 'Shared Film': { pos: 20, agoMin: 10 } },
    watchFor: { alice: { 'Only On A': { pos: 30, agoMin: 2 } } },
    ...mockA,
  });
  const b = createMockJellyfin({
    name: 'B', apiKey: 'unused', login: { user: 'demo', pass: 'pw' }, users: ['demo', 'alice'], titles: B_TITLES, legacyOnly: true,
    ...mockB,
  });
  const [ua, ub] = [await a.start(), await b.start()];
  const ctx = createApp({
    dataDir: ':memory:',
    env: { RFLIX_SETUP_CODE: 'abc123' },
    log: () => {},
    legacy: legacy
      ? {
          servers: [
            { name: 'Server A', url: ua, authType: 'apikey', apiKey: 'key-a' },
            { name: 'Server B', url: ub, authType: 'login', username: 'demo', password: 'pw' },
          ],
          settings: {},
        }
      : { servers: [], settings: {} },
  });
  // Tests need fast health checks / short timeouts (the admin UI enforces sane minimums).
  ctx.settings.values.healthIntervalSeconds = 0.2;
  for (const s of ctx.reg.list()) s.timeoutMs = 1500;
  ctx.start();
  const httpServer = await new Promise((res) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => res(s));
  });
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  const admin = makeClient(base);
  const setup = await admin.post('/api/setup', { code: 'abc123', username: 'admin', password: 'correct horse', displayName: 'Admin' });
  if (setup.status !== 201) throw new Error(`setup failed: ${JSON.stringify(setup.body)}`);

  return {
    a, b, ctx, base, admin, urls: { a: ua, b: ub },
    client: () => makeClient(base),
    async close() {
      ctx.stop();
      httpServer.closeAllConnections();
      httpServer.close();
      await Promise.all([a.stop(), b.stop()]);
    },
  };
}
