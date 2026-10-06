import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniform base62 via rejection sampling (bytes ≥ 248 are discarded; `b % 62` alone would bias the first 8 symbols). */
function base62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248) out += BASE62[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * `sk_live_<prefix>_<secret>`:
 *  - `sk_live_` / `sk_test_` → secret scanners (GitHub push protection) can
 *    recognise leaked keys, and humans see the mode at a glance;
 *  - prefix (12 chars) = public lookup id, stored in clear, shown in the UI;
 *  - secret (32 chars ≈ 190 bits) = only its SHA-256(pepper + secret) is stored.
 * A fast hash is right here (unlike passwords): the secret is high-entropy
 * random, so brute force is infeasible regardless of hash speed, and a slow
 * hash per API call would cost real CPU at 30k RPS.
 */
export function generateApiKey(livemode: boolean): { key: string; prefix: string; secret: string } {
  const prefix = base62(12);
  const secret = base62(32);
  return { key: `sk_${livemode ? 'live' : 'test'}_${prefix}_${secret}`, prefix, secret };
}

export function parseApiKey(raw: string): { livemode: boolean; prefix: string; secret: string } | null {
  const m = /^sk_(live|test)_([0-9A-Za-z]{12})_([0-9A-Za-z]{32})$/.exec(raw);
  return m ? { livemode: m[1] === 'live', prefix: m[2], secret: m[3] } : null;
}

export function hashSecret(secret: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${secret}`).digest('base64url');
}

export function secretMatches(secret: string, storedHash: string, pepper: string): boolean {
  const a = Buffer.from(hashSecret(secret, pepper));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const API_SCOPES = ['products:read', 'products:write', 'orders:read', 'stock:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
