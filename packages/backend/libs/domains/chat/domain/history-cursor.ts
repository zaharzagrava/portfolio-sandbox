/**
 * Opaque cursors and the sync window arithmetic of S24 (FR-020, FR-023). The history cursor is base64url of
 * `{seq}`; it is unsigned because it grants nothing (the membership predicate applies to every page). Pure.
 */
export const SYNC_PAGE_SIZE = 200;

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

function decode(cursor: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

export function encodeHistoryCursor(seq: number): string {
  return encode({ seq });
}

/** The `seq` the next page starts below, or null for any malformed or tampered cursor. */
export function decodeHistoryCursor(cursor: string): number | null {
  const v = decode(cursor);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const seq = (v as { seq?: unknown }).seq;
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 1
    ? seq
    : null;
}

/**
 * Keyset position of the unread list, ordered by `(activity DESC, channelId DESC)`. `at` is the activity time exactly as
 * the database printed it (`timestamptz::text`): a JavaScript date keeps milliseconds, rows written with `now()` have
 * microseconds, and a truncated cursor would repeat or skip a channel at a page boundary.
 */
export interface UnreadCursor {
  at: string;
  channelId: string;
}

export function encodeUnreadCursor(at: string, channelId: string): string {
  return encode({ at, channelId });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_TIMESTAMPTZ =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export function decodeUnreadCursor(cursor: string): UnreadCursor | null {
  const v = decode(cursor);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { at, channelId } = v as Record<string, unknown>;
  if (typeof at !== 'string' || typeof channelId !== 'string') return null;
  if (!PG_TIMESTAMPTZ.test(at) || !UUID.test(channelId)) return null;
  return { at, channelId };
}

export interface SyncWindow {
  fromSeq: number;
  toSeq: number;
  hasMore: boolean;
}

/** Messages `fromSeq..toSeq` (inclusive, empty when `toSeq < fromSeq`) follow a client's cursor. */
export function syncWindow(
  cursor: number,
  lastSeq: number,
  pageSize: number = SYNC_PAGE_SIZE,
): SyncWindow {
  const fromSeq = cursor + 1;
  const toSeq = Math.min(lastSeq, cursor + pageSize);
  return { fromSeq, toSeq, hasMore: cursor + pageSize < lastSeq };
}
