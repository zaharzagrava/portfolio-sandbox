import { createHmac, timingSafeEqual } from 'node:crypto';
import { invalidCursor } from './link-errors';

/**
 * Keyset cursor of a link's conversions: `(paidAt, id)` of the last row, bound to the owner and the link and signed with
 * a subkey of the code key, so a tampered or foreign cursor is refused (`400 invalid_cursor`), never followed.
 */
export interface ConversionCursorKey {
  paidAt: string;
  id: string;
}

const subkey = (codeKey: string) =>
  createHmac('sha256', codeKey)
    .update('share-links:conversion-cursor')
    .digest();

const sign = (codeKey: string, body: string) =>
  createHmac('sha256', subkey(codeKey)).update(body).digest('base64url');

export function encodeConversionCursor(
  codeKey: string,
  ownerId: string,
  code: string,
  last: ConversionCursorKey,
): string {
  const body = Buffer.from(
    JSON.stringify({ o: ownerId, l: code, p: last.paidAt, i: last.id }),
  ).toString('base64url');
  return `${body}.${sign(codeKey, body)}`;
}

export function decodeConversionCursor(
  codeKey: string,
  ownerId: string,
  code: string,
  cursor: string,
): ConversionCursorKey {
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
      parsed.l !== code ||
      typeof parsed.p !== 'string' ||
      typeof parsed.i !== 'string'
    )
      throw invalidCursor();
    return { paidAt: parsed.p, id: parsed.i };
  } catch {
    throw invalidCursor();
  }
}
