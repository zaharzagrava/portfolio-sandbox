import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B64URL = /^[A-Za-z0-9_-]+$/;

const mac = (key: Buffer, sessionId: string, random: string): Buffer =>
  createHmac('sha256', key).update(`${sessionId}.${random}`).digest();

const safeEqual = (a: Buffer, b: Buffer): boolean =>
  a.length === b.length && timingSafeEqual(a, b);

/**
 * CSRF token (S48 FR-043): a random part plus a keyed MAC over the session ID and that random part. Bound to one
 * session, so a token copied from another session or forged without the key does not verify. Pure.
 */
export function issueCsrfToken(key: Buffer, sessionId: string): string {
  const random = randomBytes(16).toString('base64url');
  return `${random}.${mac(key, sessionId, random).toString('base64url')}`;
}

export function verifyCsrfToken(
  key: Buffer,
  sessionId: string,
  token: string,
): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [random, given] = parts;
  if (!B64URL.test(random) || !B64URL.test(given)) return false;
  return safeEqual(
    mac(key, sessionId, random),
    Buffer.from(given, 'base64url'),
  );
}

/** Double submit: the header must equal the cookie (constant time) and verify for this session. */
export function verifyCsrfRequest(
  key: Buffer,
  sessionId: string,
  header: string | undefined,
  cookie: string | undefined,
): boolean {
  if (!header || !cookie) return false;
  if (!safeEqual(Buffer.from(header), Buffer.from(cookie))) return false;
  return verifyCsrfToken(key, sessionId, header);
}
