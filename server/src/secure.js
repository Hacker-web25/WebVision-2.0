import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Key for encrypting emails at rest. From env, else generated once next to the database. */
export function loadKey({ env = process.env, keyFile } = {}) {
  if (env.PRAVESH_KEY) {
    const k = Buffer.from(env.PRAVESH_KEY, 'base64');
    if (k.length !== 32) throw new Error('PRAVESH_KEY must be 32 bytes, base64 encoded');
    return k;
  }
  if (!keyFile) return randomBytes(32); // in-memory runs (tests): a fresh key per process
  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
  mkdirSync(dirname(keyFile), { recursive: true });
  const k = randomBytes(32);
  writeFileSync(keyFile, k.toString('base64'), { mode: 0o600 });
  return k;
}

export const token = (bytes = 16) => randomBytes(bytes).toString('base64url');
export const sha256 = s => createHash('sha256').update(s).digest('hex');

export function safeEqualHex(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function makeVault(key) {
  return {
    encrypt(text) {
      const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    decrypt(blob) {
      const b = Buffer.from(blob, 'base64'), d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
    /** Keyed hash, so the same address can be counted without storing it in the clear. */
    emailHash: email => createHmac('sha256', key).update('email:' + email).digest('hex'),
  };
}
