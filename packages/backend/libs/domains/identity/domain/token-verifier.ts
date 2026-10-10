import { createVerify, KeyObject } from 'node:crypto';
import type { AuthenticatedUser } from './authenticated-user';
import { Domain_InvalidTokenError } from './errors';

/** Pure token verification (R-06): no store, no clock of its own. The caller resolves the key by `kid` first. */

export const ACCESS_TOKEN_TYP = 'at+jwt';
export const ACCESS_TOKEN_AUDIENCE = 'marketplace-api';
export const TOKEN_ISSUER = 'marketplace';
const MAX_TOKEN_BYTES = 8 * 1024;
const CLOCK_TOLERANCE_SEC = 5;
const KID_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;
const ROLES = new Set(['USER', 'SELLER', 'MODERATOR', 'ADMIN']);

export interface TokenClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat?: number;
  nbf?: number;
  jti?: string;
  sid?: string;
  role?: string;
  amr?: string[];
  act?: { sub: string };
  [claim: string]: unknown;
}

const reject = (reason: string): never => {
  throw new Domain_InvalidTokenError(reason);
};

interface Parts {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  input: string;
  signature: Buffer;
}

function parseJson(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(segment, 'base64url').toString('utf8'),
    );
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  return reject('malformed');
}

function split(token: string): Parts {
  if (typeof token !== 'string' || token.length === 0) return reject('missing');
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) return reject('oversized');
  const segments = token.split('.');
  if (
    segments.length !== 3 ||
    segments.some((s) => !/^[A-Za-z0-9_-]*$/.test(s))
  )
    return reject('malformed');
  return {
    header: parseJson(segments[0]),
    claims: parseJson(segments[1]),
    input: `${segments[0]}.${segments[1]}`,
    signature: Buffer.from(segments[2], 'base64url'),
  };
}

/** The `kid` of a well-formed header, so the caller can fetch the key; a malformed `kid` never reaches the key store. */
export function peekKid(token: string): string {
  const { header } = split(token);
  const kid = header.kid;
  if (typeof kid !== 'string' || !KID_FORMAT.test(kid)) return reject('kid');
  return kid;
}

function verifyJws(
  token: string,
  key: KeyObject,
  now: Date,
  expected: { typ: string; aud: string },
): TokenClaims {
  const { header, claims, input, signature } = split(token);
  // The algorithm is pinned: whatever the header says, only ES256 is accepted (no `none`, no HS256/RS256 confusion).
  if (header.alg !== 'ES256') return reject('alg');
  if (header.typ !== expected.typ) return reject('typ');
  if (typeof header.kid !== 'string' || !KID_FORMAT.test(header.kid))
    return reject('kid');

  let valid = false;
  try {
    valid = createVerify('sha256')
      .update(input)
      .verify({ key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    valid = false;
  }
  if (!valid) return reject('signature');

  if (claims.iss !== TOKEN_ISSUER) return reject('iss');
  if (claims.aud !== expected.aud) return reject('aud');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0)
    return reject('sub');
  if (typeof claims.exp !== 'number') return reject('exp');
  const nowSec = now.getTime() / 1000;
  if (nowSec > claims.exp + CLOCK_TOLERANCE_SEC) return reject('expired');
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number') return reject('nbf');
    if (claims.nbf > nowSec + CLOCK_TOLERANCE_SEC) return reject('nbf');
  }
  return claims as TokenClaims;
}

/** An access token (`typ: at+jwt`, `aud: marketplace-api`) → the principal, from claims only. */
export function verifyAccessToken(
  token: string,
  key: KeyObject,
  now: Date,
): AuthenticatedUser {
  const claims = verifyJws(token, key, now, {
    typ: ACCESS_TOKEN_TYP,
    aud: ACCESS_TOKEN_AUDIENCE,
  });
  if (typeof claims.sid !== 'string' || claims.sid.length === 0)
    return reject('sid');
  if (typeof claims.role !== 'string' || !ROLES.has(claims.role))
    return reject('role');
  const amr = Array.isArray(claims.amr) ? claims.amr : [];
  if (!amr.every((m) => typeof m === 'string')) return reject('amr');
  return {
    id: claims.sub,
    role: claims.role as AuthenticatedUser['role'],
    sessionId: claims.sid,
    amr: amr as string[],
  };
}

/** MFA challenge and service tokens: the same checks, with their own `typ` and `aud`. */
export function verifyPurposeToken(
  token: string,
  key: KeyObject,
  now: Date,
  expected: { typ: string; aud: string },
): TokenClaims {
  return verifyJws(token, key, now, expected);
}
