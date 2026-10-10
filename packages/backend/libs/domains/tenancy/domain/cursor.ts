export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

/** Opaque keyset cursor: the sort key columns (including a unique tiebreaker) as a base64url JSON array of strings. */
export const encodeCursor = (key: string[]): string =>
  Buffer.from(JSON.stringify(key)).toString('base64url');

/** `null` for anything that is not a cursor of `arity` strings (tampered, truncated, foreign). */
export function decodeCursor(cursor: string, arity: number): string[] | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(value) &&
      value.length === arity &&
      value.every((v) => typeof v === 'string')
    )
      return value as string[];
  } catch {
    // falls through
  }
  return null;
}

const TIMESTAMP =
  /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d(:?\d\d)?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `(timestamp, uuid)` keyset all three lists use; anything else (even well-formed JSON) is `null`. */
export const encodeKeyset = (key: string, id: string): string =>
  encodeCursor([key, id]);

export function decodeKeyset(
  cursor: string,
): { key: string; id: string } | null {
  const parts = decodeCursor(cursor, 2);
  if (!parts || !TIMESTAMP.test(parts[0]) || !UUID.test(parts[1])) return null;
  return { key: parts[0], id: parts[1] };
}

/** `undefined` -> default; an integer 1..100; anything else `null` (the caller answers 400). */
export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_LIMIT ? n : null;
}
