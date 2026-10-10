import { createHmac, timingSafeEqual } from 'node:crypto';

/** A searchId is valid for 24 hours (FR-051). */
export const SEARCH_ID_TTL_MS = 24 * 60 * 60 * 1000;
/** Tolerated clock skew for a token issued "in the future" by another node. */
const MAX_FUTURE_SKEW_MS = 60_000;
const VERSION = 'v1';
const MAX_TOKEN_LENGTH = 1024;

export interface SearchIdPayload {
  /** the search's own id */
  sid: string;
  /** the normalised query */
  q: string;
}

export interface SearchIdClaims extends SearchIdPayload {
  /** issued-at, epoch ms */
  iat: number;
}

export type SearchIdVerdict =
  { ok: true; payload: SearchIdClaims } | { ok: false };

const mac = (key: string | Buffer, signed: string): Buffer =>
  createHmac('sha256', key).update(signed).digest();

/** `v1.<b64url(JSON{sid,q,iat})>.<b64url(HMAC-SHA256)>`; pure given `key` and `now` (epoch ms). */
export function signSearchId(
  key: string | Buffer,
  payload: SearchIdPayload,
  now: number,
): string {
  const body = Buffer.from(
    JSON.stringify({ sid: payload.sid, q: payload.q, iat: now }),
  ).toString('base64url');
  const signed = `${VERSION}.${body}`;
  return `${signed}.${mac(key, signed).toString('base64url')}`;
}

const NOT_OK: SearchIdVerdict = { ok: false };

/** Verifies the MAC in constant time, then the shape and the 24 h window. Never throws. */
export function verifySearchId(
  key: string | Buffer,
  token: string,
  now: number,
): SearchIdVerdict {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH)
    return NOT_OK;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return NOT_OK;
  const [, body, given] = parts;

  const expected = mac(key, `${VERSION}.${body}`);
  const presented = Buffer.from(given, 'base64url');
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  )
    return NOT_OK;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return NOT_OK;
  }
  const c = claims as Partial<SearchIdClaims> | null;
  if (
    c === null ||
    typeof c !== 'object' ||
    typeof c.sid !== 'string' ||
    typeof c.q !== 'string' ||
    typeof c.iat !== 'number' ||
    !Number.isFinite(c.iat)
  )
    return NOT_OK;
  if (now - c.iat > SEARCH_ID_TTL_MS || c.iat - now > MAX_FUTURE_SKEW_MS)
    return NOT_OK;
  return { ok: true, payload: { sid: c.sid, q: c.q, iat: c.iat } };
}
