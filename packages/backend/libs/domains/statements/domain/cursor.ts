import { createHmac, timingSafeEqual } from 'node:crypto';
import { invalidCursor } from './errors';

/**
 * Opaque keyset cursors (S16 contracts/http.md): `base64url(json).signature`, HMAC-SHA256 with a key derived from the
 * platform secret. The route is inside the signed payload, so a cursor issued for one list cannot drive another; a
 * tampered, unsigned or foreign cursor answers `400 invalid_cursor` and is never followed.
 */
export type CursorRoute =
  'statements' | 'rates' | 'periods' | 'findings';

export interface Cursor {
  /** Route the cursor belongs to. */
  r: CursorRoute;
  /** Scope the cursor was issued for (shop id, filter hash, month), so another scope refuses it. */
  s: string;
  /** Sort key of the last item. */
  k: string;
  /** Tiebreaker of the last item (row id). */
  id?: string;
}

const sign = (secret: string, body: string): string =>
  createHmac('sha256', `statements-cursor:${secret}`)
    .update(body)
    .digest('base64url');

export function encodeCursor(cursor: Cursor, secret: string): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

export function decodeCursor(
  raw: unknown,
  route: CursorRoute,
  scope: string,
  secret: string,
): Cursor {
  if (typeof raw !== 'string') throw invalidCursor();
  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidCursor();
  const [body, signature] = parts;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    throw invalidCursor();
  try {
    const parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Cursor;
    if (
      parsed.r !== route ||
      parsed.s !== scope ||
      typeof parsed.k !== 'string' ||
      (parsed.id !== undefined && typeof parsed.id !== 'string')
    )
      throw invalidCursor();
    return parsed;
  } catch {
    throw invalidCursor();
  }
}
