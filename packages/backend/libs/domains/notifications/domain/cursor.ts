import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboxPosition } from './ports';

const VERSION = 1;

/**
 * `<base64url(json)>.<mac>`: the keyset position (event time, item id) after which the next inbox page starts. Bound to
 * the user it was issued to and signed with the dedicated notification secret, so a cursor can neither be forged nor
 * replayed by someone else (FR-037). Opaque to clients; no expiry (a position past retention just yields an empty page).
 */
export function signCursor(
  userId: string,
  position: InboxPosition,
  secret: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: VERSION,
      u: userId,
      t: position.eventTime.getTime(),
      i: position.id,
    }),
  ).toString('base64url');
  return [payload, mac(payload, secret)].join('.');
}

/** Null for a bad shape, a bad MAC, another user's cursor and an unknown version alike. */
export function verifyCursor(
  cursor: string,
  userId: string,
  secret: string,
): InboxPosition | null {
  const parts = cursor.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;
  const expected = Buffer.from(mac(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return null;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { v, u, t, i } = body as Record<string, unknown>;
  if (v !== VERSION || u !== userId) return null;
  if (typeof t !== 'number' || !Number.isFinite(t) || typeof i !== 'string')
    return null;
  const eventTime = new Date(t);
  return Number.isNaN(eventTime.getTime()) ? null : { eventTime, id: i };
}

const mac = (payload: string, secret: string) =>
  createHmac('sha256', secret)
    .update(`inbox-cursor:${payload}`)
    .digest('base64url')
    .slice(0, 22);
