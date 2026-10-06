import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ClickClaims {
  /** Impression id = the click's identity: one impression can be billed at most once. */
  i: string;
  c: string;
  s: string;
  p: string;
  e: number;
}

/**
 * Signed impression → click token (06/01 §2.2): clicks can only be billed for
 * ads we actually served (no forged campaign ids), each impression at most
 * once, and only within 30 minutes of being shown.
 */
export function signClick(claims: ClickClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32)}`;
}

export function verifyClick(token: string, secret: string, now = Date.now()): ClickClaims | null {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32));
  if (expected.length !== Buffer.from(mac).length || !timingSafeEqual(expected, Buffer.from(mac))) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ClickClaims;
  return claims.e > now ? claims : null;
}
