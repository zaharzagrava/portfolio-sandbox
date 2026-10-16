/**
 * Opaque cursors (III.10): base64url of `v1:<kind>:<json>`. A client never builds or reads one. Decoding returns `null`
 * for anything that was not produced by `encodeCursor` with the same kind (malformed, other list, tampered).
 */
export type CursorKind = 'journal' | 'assets' | 'versions' | 'purchases';

export function encodeCursor(kind: CursorKind, payload: unknown): string {
  return Buffer.from(`v1:${kind}:${JSON.stringify(payload)}`).toString(
    'base64url',
  );
}

export function decodeCursor(kind: CursorKind, cursor: string): unknown {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(cursor))
    return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const prefix = `v1:${kind}:`;
  if (!text.startsWith(prefix)) return null;
  try {
    return JSON.parse(text.slice(prefix.length)) as unknown;
  } catch {
    return null;
  }
}

/** A journal position: a non-negative integer, or `null` when the cursor is not one. */
export function decodeSeq(cursor: string): number | null {
  const value = decodeCursor('journal', cursor);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
