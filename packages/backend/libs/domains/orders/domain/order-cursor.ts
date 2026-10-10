import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidCursorError } from './order-errors';

/**
 * Opaque keyset cursor `(createdAt, id)` bound to the principal it was issued for (S10 D-10): another buyer's or
 * shop's cursor is refused. The binding is a keyed hash of `scope`, not a secret of its own.
 */
export interface OrderCursorPosition {
  createdAt: string;
  id: string;
}

const tag = (scope: string, createdAt: string, id: string): string =>
  createHmac('sha256', 'orders-cursor')
    .update(`${scope}|${createdAt}|${id}`)
    .digest('base64url')
    .slice(0, 16);

export function encodeOrderCursor(
  scope: string,
  position: OrderCursorPosition,
): string {
  const { createdAt, id } = position;
  return Buffer.from(
    JSON.stringify([createdAt, id, tag(scope, createdAt, id)]),
  ).toString('base64url');
}

export function decodeOrderCursor(
  scope: string,
  cursor: string,
): OrderCursorPosition {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      !parsed.every((x) => typeof x === 'string')
    )
      throw new InvalidCursorError();
    const [createdAt, id, given] = parsed as [string, string, string];
    const expected = tag(scope, createdAt, id);
    if (
      given.length !== expected.length ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ||
      Number.isNaN(Date.parse(createdAt)) ||
      !/^[0-9a-f-]{36}$/i.test(id)
    )
      throw new InvalidCursorError();
    return { createdAt, id };
  } catch {
    throw new InvalidCursorError();
  }
}
