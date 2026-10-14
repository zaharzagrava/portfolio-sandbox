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
export function generateApiKey(livemode: boolean): {
  key: string;
  prefix: string;
  secret: string;
} {
  const prefix = base62(12);
  const secret = base62(32);
  return {
    key: `sk_${livemode ? 'live' : 'test'}_${prefix}_${secret}`,
    prefix,
    secret,
  };
}

export function parseApiKey(
  raw: string,
): { livemode: boolean; prefix: string; secret: string } | null {
  const m = /^sk_(live|test)_([0-9A-Za-z]{12})_([0-9A-Za-z]{32})$/.exec(raw);
  return m ? { livemode: m[1] === 'live', prefix: m[2], secret: m[3] } : null;
}

export function hashSecret(secret: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${secret}`).digest('base64url');
}

export function secretMatches(
  secret: string,
  storedHash: string,
  pepper: string,
): boolean {
  const a = Buffer.from(hashSecret(secret, pepper));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface MintedApiKey {
  key: string;
  prefix: string;
  secret: string;
}

/** Mints a key whose prefix is not taken; at most 5 attempts (data-model `ApiKey.prefix`). */
export async function generateUniqueApiKey(
  livemode: boolean,
  prefixExists: (prefix: string) => Promise<boolean>,
): Promise<MintedApiKey> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const minted = generateApiKey(livemode);
    if (!(await prefixExists(minted.prefix))) return minted;
  }
  throw new Error('Could not mint an unused API key prefix');
}

export interface Peppers {
  current: string;
  previous?: string;
}

/** `hashVersion` 1 = current pepper, 0 = previous pepper (labels; the values live in config, G-01). */
export function hashSecretWithVersion(
  secret: string,
  peppers: Peppers,
  hashVersion: number,
): string {
  const pepper = hashVersion === 1 ? peppers.current : peppers.previous;
  if (pepper === undefined) throw new Error('No pepper for this hash version');
  return hashSecret(secret, pepper);
}

/** Constant-time check against the stored hash; `rehash` tells the caller to store it under the current pepper. */
export function verifySecret(
  secret: string,
  storedHash: string,
  hashVersion: number,
  peppers: Peppers,
): { ok: boolean; rehash: boolean } {
  // the pepper the row says it was hashed with first, then the other one: a rotation of the pepper does not need a
  // data migration (rows written before it still carry label 1 but were hashed with what is now the previous pepper)
  const order: Array<{ pepper: string | undefined; current: boolean }> =
    hashVersion === 1
      ? [
          { pepper: peppers.current, current: true },
          { pepper: peppers.previous, current: false },
        ]
      : [
          { pepper: peppers.previous, current: false },
          { pepper: peppers.current, current: true },
        ];
  for (const { pepper, current } of order)
    if (pepper !== undefined && secretMatches(secret, storedHash, pepper))
      return { ok: true, rehash: !current };
  return { ok: false, rehash: false };
}

export const API_SCOPES = [
  'products:read',
  'products:write',
  'orders:read',
  'stock:write',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
