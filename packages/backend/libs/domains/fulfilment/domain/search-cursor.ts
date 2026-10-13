import { createHash } from 'node:crypto';

export type CursorValue = string | number | boolean | null;

const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Stable key of a normalised query: the same parameters in any order give the same key. */
export const queryKey = (query: Record<string, unknown>): string =>
  digest(
    JSON.stringify(
      Object.keys(query)
        .sort()
        .map((k) => [k, query[k] ?? null]),
    ),
  );

/**
 * Opaque keyset cursor (S19 FR-020, III.10): the last sort tuple plus the key of the query it belongs to, and a check
 * value over both so an edited cursor is refused. It is not a signature (no secret): it detects mistakes and reuse
 * against another query, and leaks nothing but the position of a public listing.
 */
export function encodeCursor(tuple: CursorValue[], keyOfQuery: string): string {
  const body = { t: tuple, q: keyOfQuery };
  return Buffer.from(
    JSON.stringify({ ...body, c: digest(JSON.stringify(body)) }),
  ).toString('base64url');
}

/** The tuple, or `null` for anything that is not a cursor of this query. */
export function decodeCursor(
  cursor: string,
  keyOfQuery: string,
): CursorValue[] | null {
  try {
    const raw: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      return null;
    const { t, q, c } = raw as { t?: unknown; q?: unknown; c?: unknown };
    if (!Array.isArray(t) || q !== keyOfQuery || typeof c !== 'string')
      return null;
    if (c !== digest(JSON.stringify({ t, q }))) return null;
    return t as CursorValue[];
  } catch {
    return null;
  }
}
