import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const mac = (secret: string, sid: string, random: string): Buffer =>
  createHmac('sha256', secret).update(`csrf:${sid}:${random}`).digest();

/** A random part and a keyed MAC over the session ID and that part: bound to the session (FR-051). */
export function issueCsrfToken(secret: string, sid: string): string {
  const random = randomBytes(24).toString('base64url');
  return `${random}.${mac(secret, sid, random).toString('base64url')}`;
}

/**
 * Accepts only a header that equals the cookie and carries a MAC this server issued for `sid`. Both comparisons are
 * constant-time; any malformed input is simply "no" (never an exception).
 */
export function verifyCsrfToken(input: {
  secret: string;
  sid: string;
  header: string;
  cookie: string;
}): boolean {
  const { secret, sid, header, cookie } = input;
  if (!header || !cookie) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(cookie);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const parts = header.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  // Compare the canonical text, not decoded bytes: base64url ignores the spare bits of its last character.
  const given = Buffer.from(parts[1]);
  const expected = Buffer.from(
    mac(secret, sid, parts[0]).toString('base64url'),
  );
  return given.length === expected.length && timingSafeEqual(given, expected);
}
