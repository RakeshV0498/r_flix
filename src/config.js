/**
 * Configuration loading for r_flix.
 *
 * Sources, lowest to highest priority:
 *   1. Built-in defaults (below)
 *   2. A JSON file: $RFLIX_CONFIG, or ./config/config.json
 *   3. Environment variables (see .env.example)
 *
 * Server credentials are NEVER hardcoded: they come from the file and/or the
 * environment only. Servers are numbered from 1 in the environment:
 *   JELLYFIN_1_URL, JELLYFIN_1_API_KEY, JELLYFIN_1_USERNAME, JELLYFIN_1_PASSWORD,
 *   JELLYFIN_1_NAME, JELLYFIN_1_USER_ID   (and JELLYFIN_2_*, ... up to 9)
 * Environment values override the same-numbered entry in the config file, and
 * can also add servers the file does not have.
 *
 * The ORDER of servers is their priority: when a title exists on several
 * servers, the first reachable one in this order is used.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_SERVERS = 9; // the server index is encoded as one digit in item ids

export class ConfigError extends Error {}

const DEFAULTS = {
  port: 8080,
  /** How long a fetched library is considered fresh (also the refresh interval). */
  cacheTtlSeconds: 300,
  /** How often each server is pinged to update the online/offline indicator. */
  healthIntervalSeconds: 20,
  /** Timeout for ordinary Jellyfin API calls. */
  requestTimeoutMs: 8000,
  dedupe: {
    /** For items with no TMDB/IMDb/TVDB id, match on normalised title + year. */
    fallbackToTitleYear: true,
  },
  playback: {
    /** Cap for streams, in megabits per second. All video is relayed through the Pi's slow NIC. */
    maxBitrateMbps: 12,
    /** Set true if your browsers/TVs can decode HEVC (Safari, most smart TVs). */
    allowHevc: false,
    /** Audio codecs the browser can direct-play inside MP4. */
    directPlayAudio: 'aac,mp3,opus,flac',
    /** Skip direct play and always ask Jellyfin to transcode (debugging). */
    forceTranscode: false,
  },
};

const ENV_FIELDS = [
  ['URL', 'url'],
  ['API_KEY', 'apiKey'],
  ['USERNAME', 'username'],
  ['PASSWORD', 'password'],
  ['NAME', 'name'],
  ['USER_ID', 'userId'],
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${file}: ${err.message}`);
  }
}

function normalizeServer(raw, i) {
  const label = `Server ${i + 1}`;
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${label} is not configured`);
  let url;
  try {
    url = new URL(String(raw.url || ''));
    if (!/^https?:$/.test(url.protocol)) throw new Error('bad protocol');
  } catch {
    throw new ConfigError(`${label}: "url" must be a full http(s) URL, e.g. http://192.168.1.10:8096`);
  }
  const hasKey = !!raw.apiKey;
  const hasLogin = !!(raw.username && raw.password);
  if (!hasKey && !hasLogin) {
    throw new ConfigError(`${label}: set either "apiKey" or both "username" and "password"`);
  }
  return Object.freeze({
    name: String(raw.name || `Server ${i + 1}`),
    url: url.toString().replace(/\/+$/, ''), // no trailing slash
    apiKey: raw.apiKey ? String(raw.apiKey) : null,
    username: raw.username ? String(raw.username) : null,
    password: raw.password ? String(raw.password) : null,
    userId: raw.userId ? String(raw.userId).replace(/-/g, '').toLowerCase() : null,
  });
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const file = env.RFLIX_CONFIG ? path.resolve(env.RFLIX_CONFIG) : path.resolve(cwd, 'config/config.json');
  const fileCfg = fs.existsSync(file) ? readJson(file) : {};

  // --- servers: file entries, overridden/extended by JELLYFIN_<n>_* variables
  const rawServers = Array.isArray(fileCfg.servers) ? fileCfg.servers.map((s) => ({ ...s })) : [];
  for (let n = 1; n <= MAX_SERVERS; n++) {
    const over = {};
    for (const [suffix, key] of ENV_FIELDS) {
      const v = env[`JELLYFIN_${n}_${suffix}`];
      if (v) over[key] = v;
    }
    if (Object.keys(over).length) rawServers[n - 1] = { ...(rawServers[n - 1] || {}), ...over };
  }
  if (rawServers.length === 0) {
    throw new ConfigError(
      `No Jellyfin servers configured. Copy config/config.sample.json to ${file} ` +
        'or set JELLYFIN_1_URL / JELLYFIN_1_API_KEY (see README).',
    );
  }
  if (rawServers.length > MAX_SERVERS) throw new ConfigError(`At most ${MAX_SERVERS} servers are supported`);
  const servers = Array.from(rawServers, (s, i) => normalizeServer(s, i)); // Array.from fills holes

  const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : fallback);
  const cfg = {
    port: num(env.PORT ?? fileCfg.port, DEFAULTS.port),
    cacheTtlSeconds: num(env.RFLIX_CACHE_TTL ?? fileCfg.cacheTtlSeconds, DEFAULTS.cacheTtlSeconds),
    healthIntervalSeconds: num(fileCfg.healthIntervalSeconds, DEFAULTS.healthIntervalSeconds),
    requestTimeoutMs: num(fileCfg.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
    dedupe: { ...DEFAULTS.dedupe, ...(fileCfg.dedupe || {}) },
    playback: { ...DEFAULTS.playback, ...(fileCfg.playback || {}) },
    servers,
  };
  return cfg;
}
