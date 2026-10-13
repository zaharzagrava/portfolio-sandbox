import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AD_TOKEN_MAX_LENGTH } from '@marketplace-sandbox/contracts';

/** The readable claims of a click token. No user id, anonymous id, address or price (FR-013). */
export interface ClickClaims {
  /** Impression id = the click's identity: one impression can be billed at most once. */
  i: string;
  c: string;
  s: string;
  p: string;
  /** Expiry, epoch milliseconds; `now >= e` is expired. */
  e: number;
  /** Keyed one-way viewer hash (32 hex). */
  v: string;
}

export interface TokenKeys {
  current: string;
  /** The secret before a rotation; tokens it signed stay valid for their 30 minutes. */
  previous?: string;
}

export type VerifyResult =
  | { ok: true; claims: ClickClaims; keyId: string }
  | { ok: false; reason: 'invalid' | 'expired' };

const claimsSchema = z
  .object({
    i: z.uuid(),
    c: z.uuid(),
    s: z.uuid(),
    p: z.uuid(),
    e: z.number().int(),
    v: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

const VERSION = 'v1';
const SEGMENTS = 4;

/** One secret, several purposes: a subkey per purpose, so the signing key is never the hashing key (R-7). */
const subkey = (secret: string, purpose: string): Buffer =>
  createHmac('sha256', secret).update(`ads:${purpose}`).digest();

/** First 8 hex of a keyed hash of a constant: names the key without revealing it, so rotation picks the key directly. */
export const keyIdOf = (secret: string): string =>
  subkey(secret, 'kid').toString('hex').slice(0, 8);

const sign = (secret: string, signed: string): string =>
  createHmac('sha256', subkey(secret, 'token'))
    .update(signed)
    .digest('base64url');

/** `v1.<kid>.<payload>.<signature>`; the signature covers everything before it. The claims are not validated here. */
export function signClickToken(claims: ClickClaims, keys: TokenKeys): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signed = `${VERSION}.${keyIdOf(keys.current)}.${payload}`;
  return `${signed}.${sign(keys.current, signed)}`;
}

const equalStrings = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * FR-014: constant-time signature check over the exact string, then claim shape, then expiry; a previous key is tried
 * only when its id matches. Never throws: every failure is `invalid` except a correctly signed, expired token.
 */
export function verifyClickToken(
  token: string,
  keys: TokenKeys,
  nowMs: number,
): VerifyResult {
  const invalid: VerifyResult = { ok: false, reason: 'invalid' };
  try {
    if (typeof token !== 'string' || token.length > AD_TOKEN_MAX_LENGTH)
      return invalid;
    const parts = token.split('.');
    if (parts.length !== SEGMENTS || parts[0] !== VERSION) return invalid;
    const [, kid, payload, signature] = parts;
    const secret = [keys.current, keys.previous].find(
      (candidate): candidate is string =>
        !!candidate && keyIdOf(candidate) === kid,
    );
    if (!secret) return invalid;
    const signed = `${VERSION}.${kid}.${payload}`;
    if (!equalStrings(signature, sign(secret, signed))) return invalid;
    const parsed = claimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    if (!parsed.success) return invalid;
    if (nowMs >= parsed.data.e) return { ok: false, reason: 'expired' };
    return { ok: true, claims: parsed.data, keyId: kid };
  } catch {
    return invalid;
  }
}

/** 32 hex of a keyed hash. `identity` carries its kind as a prefix (`user:`, `anon:`, `ip:`) chosen by the caller. */
const keyedHash = (secret: string, purpose: string, value: string): string =>
  createHmac('sha256', subkey(secret, purpose))
    .update(value)
    .digest('hex')
    .slice(0, 32);

export const hashViewer = (secret: string, identity: string): string =>
  keyedHash(secret, 'viewer', identity);

export const hashAddress = (secret: string, address: string): string =>
  keyedHash(secret, 'ip', address);
