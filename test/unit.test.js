import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeUid, decodeUid } from '../src/ids.js';
import { mergeLibraries, mergeUd, slim } from '../src/catalogue.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { rewritePlaylist } from '../src/proxy.js';
import { deviceProfile } from '../src/playback.js';

const item = (s, id, over = {}) => ({ s, id, type: 'Movie', name: 'X', year: 2000, providers: {}, ...over });

test('uid round-trips and rejects junk', () => {
  const v = [{ s: 0, id: 'a'.repeat(32) }, { s: 1, id: 'B'.repeat(32) }];
  const uid = encodeUid(v);
  assert.deepEqual(decodeUid(uid), [{ s: 0, id: 'a'.repeat(32) }, { s: 1, id: 'b'.repeat(32) }]);
  for (const bad of ['', 'x', '0abc', `0${'g'.repeat(32)}`, null, `0${'a'.repeat(32)}-`]) assert.equal(decodeUid(bad), null, String(bad));
});

test('same TMDB id on two servers merges into one title, in server priority order', () => {
  const groups = mergeLibraries([
    { s: 0, items: [item(0, '1'.repeat(32), { name: 'Heat', providers: { tmdb: '949' } })] },
    { s: 1, items: [item(1, '2'.repeat(32), { name: 'Heat (1995)', providers: { tmdb: '949' } })] },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].variants.map((v) => v.s), [0, 1]);
});

test('matches on IMDb when one copy lacks TMDB (transitive via any shared id)', () => {
  const groups = mergeLibraries([
    { s: 0, items: [item(0, '1'.repeat(32), { providers: { tmdb: '5', imdb: 'tt1' } })] },
    { s: 1, items: [item(1, '2'.repeat(32), { providers: { imdb: 'tt1' } })] },
  ]);
  assert.equal(groups.length, 1);
});

test('a movie and a series with the same TMDB number are NOT duplicates', () => {
  const groups = mergeLibraries([
    { s: 0, items: [item(0, '1'.repeat(32), { providers: { tmdb: '603' } })] },
    { s: 1, items: [item(1, '2'.repeat(32), { type: 'Series', providers: { tmdb: '603' } })] },
  ]);
  assert.equal(groups.length, 2);
});

test('title+year fallback only applies when there are no provider ids, and can be disabled', () => {
  const libs = [
    { s: 0, items: [item(0, '1'.repeat(32), { name: 'Amélie', year: 2001 })] },
    { s: 1, items: [item(1, '2'.repeat(32), { name: 'Amelie!', year: 2001 })] },
  ];
  assert.equal(mergeLibraries(libs).length, 1);
  assert.equal(mergeLibraries(libs, { fallbackToTitleYear: false }).length, 2);
  // different TMDB ids beat a matching title
  const libs2 = [
    { s: 0, items: [item(0, '1'.repeat(32), { providers: { tmdb: '1' } })] },
    { s: 1, items: [item(1, '2'.repeat(32), { providers: { tmdb: '2' } })] },
  ];
  assert.equal(mergeLibraries(libs2).length, 2);
});

test('two copies on the SAME server are not collapsed', () => {
  const groups = mergeLibraries([
    { s: 0, items: [item(0, '1'.repeat(32), { providers: { tmdb: '7' } }), item(0, '3'.repeat(32), { providers: { tmdb: '7' } })] },
  ]);
  assert.equal(groups.length, 2);
});

test('watch state: the most recently played copy wins', () => {
  const old = { played: false, pos: 5e9, last: 1000, unplayed: null };
  const fresh = { played: true, pos: 0, last: 2000, unplayed: null };
  assert.equal(mergeUd([old, fresh]).played, true);
  assert.equal(mergeUd([old, null]).pos, 5e9);
  assert.equal(mergeUd([]).played, false);
});

test('slim() keeps only what we need and normalises ids', () => {
  const s = slim({ Id: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', Type: 'Movie', Name: 'N', ProviderIds: { Tmdb: 12, IMDB: 'tt9' }, ImageTags: { Primary: 'x' }, BackdropImageTags: [] }, 1);
  assert.equal(s.id, 'a'.repeat(32));
  assert.deepEqual(s.providers, { tmdb: '12', imdb: 'tt9' });
  assert.equal(s.hasPoster, true);
  assert.equal(s.hasBackdrop, false);
});

test('config: env overrides file, requires credentials, never needs hardcoding', () => {
  const env = { RFLIX_CONFIG: '/nonexistent.json', JELLYFIN_1_URL: 'http://10.0.0.5:8096/', JELLYFIN_1_API_KEY: 'k', JELLYFIN_2_URL: 'http://10.0.0.6:8096', JELLYFIN_2_USERNAME: 'u', JELLYFIN_2_PASSWORD: 'p', PORT: '9000' };
  const cfg = loadConfig(env);
  assert.equal(cfg.servers.length, 2);
  assert.equal(cfg.servers[0].url, 'http://10.0.0.5:8096'); // trailing slash trimmed
  assert.equal(cfg.port, 9000);
  assert.throws(() => loadConfig({ RFLIX_CONFIG: '/nonexistent.json' }), ConfigError);
  assert.throws(() => loadConfig({ RFLIX_CONFIG: '/x', JELLYFIN_1_URL: 'http://a' }), /apiKey/);
  assert.throws(() => loadConfig({ RFLIX_CONFIG: '/x', JELLYFIN_1_URL: 'nope', JELLYFIN_1_API_KEY: 'k' }), /http/);
});

test('playlist rewriting hides server addresses and tokens', () => {
  const out = rewritePlaylist(
    '#EXTM3U\n#EXT-X-MAP:URI="/videos/a/init.mp4?api_key=SECRET&x=1"\nhttp://192.168.1.10:8096/videos/a/hls1/main/0.ts?api_key=SECRET\nhls1/main/1.ts?x=2\n',
    1, 'http://192.168.1.10:8096',
  );
  assert.ok(!out.includes('192.168'));
  assert.ok(!out.includes('SECRET'));
  assert.ok(out.includes('URI="/proxy/1/videos/a/init.mp4?x=1"'));
  assert.ok(out.includes('/proxy/1/videos/a/hls1/main/0.ts'));
  assert.ok(out.includes('\nhls1/main/1.ts?x=2')); // relative lines untouched
});

test('device profile honours config', () => {
  const p = deviceProfile({ maxBitrateMbps: 8, allowHevc: true, directPlayAudio: 'aac' });
  assert.equal(p.MaxStreamingBitrate, 8_000_000);
  assert.match(p.DirectPlayProfiles[0].VideoCodec, /hevc/);
});
