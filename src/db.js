/**
 * SQLite storage (Node's built-in node:sqlite: no native module to build on a Pi).
 * One file in the data directory. WAL + synchronous=NORMAL keeps SD-card writes low.
 *
 * Tables
 *   settings      key/value app settings (JSON values)
 *   servers       Jellyfin servers: stable `slot` (0-8, encoded into item ids), priority
 *                 `position`, and the credentials encrypted in `secret`
 *   users         r_flix accounts (scrypt password hashes, role admin|user)
 *   user_servers  which Jellyfin user each r_flix user maps to, per server slot
 *   sessions      login sessions (only a hash of the cookie token is stored)
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  /* v1 */ `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE servers (
    slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 0 AND 8),
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    auth_type TEXT NOT NULL CHECK (auth_type IN ('apikey','login')),
    secret TEXT NOT NULL,
    hint_user TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','user')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login INTEGER
  );
  CREATE TABLE user_servers (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL,
    jf_user_id TEXT NOT NULL,
    PRIMARY KEY (user_id, slot)
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  `,
];

export function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dir === ':memory:' ? dir : path.join(dir, 'rflix.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}

/** Run fn inside a transaction; roll back if it throws. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
