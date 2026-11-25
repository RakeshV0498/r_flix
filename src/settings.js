/**
 * Application settings, editable on the Admin page and stored in the database.
 * `values` is ONE live object that is updated in place, so any module holding
 * a reference to it (or to `values.playback`) sees changes immediately.
 */
import { EventEmitter } from 'node:events';
import { HttpError } from './http-error.js';

export const DEFAULTS = {
  cacheTtlSeconds: 300, // library refresh interval
  mediaTimeoutSeconds: 90, // how long to wait for a server to START a video before giving up
  healthIntervalSeconds: 20, // how often servers are pinged
  requestTimeoutMs: 8000, // Jellyfin API call timeout
  dedupe: { fallbackToTitleYear: true },
  playback: {
    maxBitrateMbps: 12,
    allowHevc: false,
    directPlayAudio: 'aac,mp3,opus,flac',
    forceTranscode: false,
  },
};

/** [dotted key, type, min, max, label] — drives validation (the UI mirrors this). */
export const SCHEMA = [
  ['cacheTtlSeconds', 'int', 30, 86400],
  ['mediaTimeoutSeconds', 'int', 10, 600],
  ['healthIntervalSeconds', 'int', 5, 3600],
  ['requestTimeoutMs', 'int', 1000, 60000],
  ['dedupe.fallbackToTitleYear', 'bool'],
  ['playback.maxBitrateMbps', 'num', 1, 200],
  ['playback.allowHevc', 'bool'],
  ['playback.directPlayAudio', 'codecs'],
  ['playback.forceTranscode', 'bool'],
];

const get = (o, k) => k.split('.').reduce((a, p) => a?.[p], o);
function set(o, k, v) {
  const parts = k.split('.');
  const last = parts.pop();
  parts.reduce((a, p) => a[p], o)[last] = v;
}

function coerce(key, type, min, max, raw) {
  const bad = (msg) => new HttpError(400, `${key}: ${msg}`);
  switch (type) {
    case 'bool':
      if (typeof raw !== 'boolean') throw bad('must be true or false');
      return raw;
    case 'int':
    case 'num': {
      const n = Number(raw);
      if (raw === '' || raw === null || !Number.isFinite(n) || (type === 'int' && !Number.isInteger(n))) throw bad('must be a number');
      if (n < min || n > max) throw bad(`must be between ${min} and ${max}`);
      return n;
    }
    case 'codecs': {
      const s = String(raw).toLowerCase().replace(/\s+/g, '');
      if (!/^[a-z0-9_-]+(,[a-z0-9_-]+)*$/.test(s) || s.length > 100) throw bad('use a comma-separated list like aac,mp3,opus');
      return s;
    }
    default:
      throw bad('unknown type');
  }
}

export class Settings extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.values = structuredClone(DEFAULTS);
    for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
      const def = SCHEMA.find(([k]) => k === key);
      if (!def) continue; // setting removed in a newer version
      try {
        set(this.values, key, coerce(key, def[1], def[2], def[3], JSON.parse(value)));
      } catch {
        /* corrupt/out-of-range stored value: keep the default */
      }
    }
  }

  /** Validate everything first, then apply all-or-nothing. @param {Record<string, any>} patch nested or dotted */
  update(patch) {
    const flat = {};
    const walk = (o, prefix) => {
      for (const [k, v] of Object.entries(o || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
        else flat[key] = v;
      }
    };
    walk(patch, '');
    const next = {};
    for (const [key, raw] of Object.entries(flat)) {
      const def = SCHEMA.find(([k]) => k === key);
      if (!def) throw new HttpError(400, `Unknown setting: ${key}`);
      next[key] = coerce(key, def[1], def[2], def[3], raw);
    }
    const save = this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const changed = [];
    for (const [key, value] of Object.entries(next)) {
      if (get(this.values, key) === value) continue;
      save.run(key, JSON.stringify(value));
      set(this.values, key, value);
      changed.push(key);
    }
    if (changed.length) this.emit('change', changed);
    return this.values;
  }
}
