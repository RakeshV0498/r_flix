/**
 * Bootstrap configuration: only what must be known BEFORE the database is open.
 *
 *   PORT              listen port (default 8080)
 *   RFLIX_DATA        directory for the database + key file (default ./data; /data in Docker)
 *   RFLIX_SECRET      optional: encryption key for stored Jellyfin credentials (see crypto.js)
 *   RFLIX_TRUST_PROXY set to 1 when behind a reverse proxy (so Secure cookies / client IPs work)
 *
 * Everything else (Jellyfin servers, users, playback and cache settings) lives in the
 * database and is managed on the Admin page.
 *
 * LEGACY IMPORT. Earlier versions were configured with config/config.json and
 * JELLYFIN_<n>_* variables. If the database has no servers yet, those are imported once at
 * start-up (readLegacy below) and ignored afterwards — edit them on the Admin page.
 */
import fs from 'node:fs';
import path from 'node:path';

export class ConfigError extends Error {}

const MAX_SERVERS = 9; // the server slot is encoded as one digit in item ids

export function loadBootstrap(env = process.env, cwd = process.cwd()) {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`Invalid PORT: ${env.PORT}`);
  return {
    port,
    dataDir: path.resolve(cwd, env.RFLIX_DATA || 'data'),
    trustProxy: env.RFLIX_TRUST_PROXY === '1' || env.RFLIX_TRUST_PROXY === 'true',
  };
}

const ENV_FIELDS = [
  ['URL', 'url'],
  ['API_KEY', 'apiKey'],
  ['USERNAME', 'username'],
  ['PASSWORD', 'password'],
  ['NAME', 'name'],
];

/**
 * Read the pre-database config sources. Returns { servers: [...], settings: {...} }, where
 * servers use the registry's input shape and settings use the Settings patch shape.
 * Never throws for "nothing configured"; throws ConfigError for a file that exists but is broken.
 */
export function readLegacy(env = process.env, cwd = process.cwd()) {
  const file = env.RFLIX_CONFIG ? path.resolve(env.RFLIX_CONFIG) : path.resolve(cwd, 'config/config.json');
  let fileCfg = {};
  if (fs.existsSync(file)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new ConfigError(`Cannot read config file ${file}: ${err.message}`);
    }
  }
  const raw = Array.isArray(fileCfg.servers) ? fileCfg.servers.map((s) => ({ ...s })) : [];
  for (let n = 1; n <= MAX_SERVERS; n++) {
    const over = {};
    for (const [suffix, key] of ENV_FIELDS) if (env[`JELLYFIN_${n}_${suffix}`]) over[key] = env[`JELLYFIN_${n}_${suffix}`];
    if (Object.keys(over).length) raw[n - 1] = { ...(raw[n - 1] || {}), ...over };
  }
  const servers = [];
  raw.forEach((s, i) => {
    if (!s || !s.url) return; // skip holes and half-filled entries
    const authType = s.apiKey ? 'apikey' : 'login';
    servers.push({
      name: s.name || `Server ${i + 1}`,
      url: s.url,
      authType,
      apiKey: s.apiKey,
      username: s.username,
      password: s.password,
    });
  });
  const settings = {};
  for (const k of ['cacheTtlSeconds', 'healthIntervalSeconds', 'requestTimeoutMs']) if (fileCfg[k] != null) settings[k] = fileCfg[k];
  if (fileCfg.dedupe) settings.dedupe = fileCfg.dedupe;
  if (fileCfg.playback) settings.playback = fileCfg.playback;
  if (env.RFLIX_CACHE_TTL) settings.cacheTtlSeconds = Number(env.RFLIX_CACHE_TTL);
  return { servers, settings };
}
