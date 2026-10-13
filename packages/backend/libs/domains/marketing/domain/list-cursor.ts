import { createHmac, timingSafeEqual } from 'node:crypto';
import { invalidCursor } from './link-errors';
import type { ListCursorKey } from './ports';

/**
 * Keyset cursor of the owner's list (G18): `(createdAt, code)` of the last item, bound to the owner and signed with a
 * subkey of the code key, so a tampered or foreign cursor is refused (`400 invalid_cursor`), never followed.
 */
const subkey = (codeKey: string) =>
  createHmac('sha256', codeKey).update('share-links:list-cursor').digest();

const sign = (codeKey: string, body: string) =>
  createHmac('sha256', subkey(codeKey)).update(body).digest('base64url');

export function encodeCursor(
  codeKey: string,
  ownerId: string,
  last: ListCursorKey,
): string {
  const body = Buffer.from(
    JSON.stringify({ o: ownerId, c: last.createdAt, k: last.code }),
  ).toString('base64url');
  return `${body}.${sign(codeKey, body)}`;
}

export function decodeCursor(
  codeKey: string,
  ownerId: string,
  cursor: string,
): ListCursorKey {
  const [body, signature, extra] = cursor.split('.');
  if (!body || !signature || extra !== undefined) throw invalidCursor();
  const expected = Buffer.from(sign(codeKey, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    throw invalidCursor();
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (
      parsed.o !== ownerId ||
      typeof parsed.c !== 'string' ||
      typeof parsed.k !== 'string'
    )
      throw invalidCursor();
    return { createdAt: parsed.c, code: parsed.k };
  } catch {
    throw invalidCursor();
  }
}
