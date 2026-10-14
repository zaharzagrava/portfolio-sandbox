import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidCursorError } from './auction-errors';

/**
 * Opaque keyset cursor (S21 FR-009). The parts are the sort key of the last row; the tag binds the cursor to the list
 * it was issued for (`scope`: the shop's list or one auction's history), so a foreign or edited cursor is refused with
 * `400 invalid_cursor`. The tag is a keyed hash of the scope, not a secret of its own.
 */
const tag = (scope: string, parts: readonly string[]): string =>
  createHmac('sha256', 'auctions-cursor')
    .update([scope, ...parts].join('|'))
    .digest('base64url')
    .slice(0, 16);

export function encodeCursor(scope: string, parts: readonly string[]): string {
  return Buffer.from(JSON.stringify([...parts, tag(scope, parts)])).toString(
    'base64url',
  );
}

export function decodeCursor(
  scope: string,
  cursor: string,
  arity: number,
): string[] {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== arity + 1 ||
      !parsed.every((x) => typeof x === 'string')
    )
      throw new InvalidCursorError();
    const given = parsed[arity] as string;
    const parts = parsed.slice(0, arity) as string[];
    const expected = tag(scope, parts);
    if (
      given.length !== expected.length ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    )
      throw new InvalidCursorError();
    return parts;
  } catch {
    throw new InvalidCursorError();
  }
}
