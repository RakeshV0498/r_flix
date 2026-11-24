/**
 * Encryption for secrets stored in the database (Jellyfin API keys and passwords).
 *
 * AES-256-GCM with a random IV per value. The key comes from, in order:
 *   1. RFLIX_SECRET (environment) — recommended: keeps the key off the data volume
 *   2. <data dir>/secret.key — generated on first run (mode 0600)
 * Either way, a copy of rflix.db alone does not reveal your Jellyfin credentials.
 * LOSING THE KEY MAKES STORED SERVER CREDENTIALS UNREADABLE (re-enter them in Admin).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function loadKey(dataDir, env = process.env) {
  if (env.RFLIX_SECRET) return crypto.scryptSync(String(env.RFLIX_SECRET), 'r_flix.secret.v1', 32);
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`${file} is not a valid 32-byte key`);
    return key;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  return key;
}

/** @returns {string} "v1.<iv>.<tag>.<ciphertext>" (base64url parts) */
export function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((p, i) => (i ? p.toString('base64url') : p)).join('.');
}

/** @throws if the blob was tampered with or the key is wrong */
export function decrypt(key, blob) {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unrecognised encrypted value');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
