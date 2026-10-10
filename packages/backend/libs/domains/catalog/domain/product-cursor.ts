import { createHash } from 'node:crypto';

/** Everything a cursor is bound to: the same cursor is refused for another shop or another filter set. */
export interface CursorScope {
  shopId: string;
  status: string;
  category: string | null;
  inStock: boolean | null;
}

/** The keyset position: `createdAt` as the database prints it (microseconds kept) and the id tiebreaker. */
export interface CursorKey {
  createdAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/;

const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

const scopeKey = (scope: CursorScope): string =>
  JSON.stringify([scope.shopId, scope.status, scope.category, scope.inStock]);

/**
 * Opaque keyset cursor for `ORDER BY "createdAt" DESC, "id" DESC` (III.10): base64url of `[createdAt, id, checksum]`,
 * where the checksum covers the position and the scope. Not a secret; it detects tampering and reuse across lists.
 */
export const encodeProductCursor = (
  key: CursorKey,
  scope: CursorScope,
): string => {
  const check = digest(`${key.createdAt}|${key.id}|${scopeKey(scope)}`);
  return Buffer.from(JSON.stringify([key.createdAt, key.id, check])).toString(
    'base64url',
  );
};

/** `null` for anything that is not a cursor issued for exactly this scope. */
export function decodeProductCursor(
  cursor: string,
  scope: CursorScope,
): CursorKey | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 512) return null;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [createdAt, id, check] = value as unknown[];
    if (
      typeof createdAt !== 'string' ||
      typeof id !== 'string' ||
      typeof check !== 'string' ||
      !TIMESTAMP.test(createdAt) ||
      !UUID.test(id)
    )
      return null;
    return check === digest(`${createdAt}|${id}|${scopeKey(scope)}`)
      ? { createdAt, id }
      : null;
  } catch {
    return null;
  }
}
