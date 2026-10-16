import type { Keyset } from './ports';

/**
 * Opaque cursors (III.10): base64url of `v1:<kind>:<json>`. A client never builds or reads one. Decoding returns `null`
 * for anything `encode*` did not produce for the same kind (malformed, other list, tampered values).
 */
type Kind = 'stories' | 'versions';

function encode(kind: Kind, payload: unknown): string {
  return Buffer.from(`v1:${kind}:${JSON.stringify(payload)}`).toString(
    'base64url',
  );
}

function decode(kind: Kind, cursor: string): unknown {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(cursor))
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeStoryCursor = (key: Keyset): string =>
  encode('stories', [key.createdAt.toISOString(), key.id]);

export function decodeStoryCursor(cursor: string): Keyset | null {
  const value = decode('stories', cursor);
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [at, id] = value as unknown[];
  if (typeof at !== 'string' || typeof id !== 'string' || !UUID.test(id))
    return null;
  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== at)
    return null;
  return { createdAt, id };
}

export const encodeVersionCursor = (version: number): string =>
  encode('versions', version);

export function decodeVersionCursor(cursor: string): number | null {
  const value = decode('versions', cursor);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
}
