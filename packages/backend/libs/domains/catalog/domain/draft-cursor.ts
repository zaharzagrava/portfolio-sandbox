import { createHash } from 'node:crypto';

/** What a draft or version cursor is bound to: the same cursor is refused for another shop, draft or filter. */
export interface DraftCursorScope {
  /** `drafts:<shopId>:<status|all>` or `versions:<shopId>:<draftId>`. */
  scope: string;
}

/** Keyset position: the timestamp as the database prints it (microseconds kept) and the id tiebreaker. */
export interface DraftCursorKey {
  at: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/;

const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

export const draftListScope = (shopId: string, status: string | null) =>
  `drafts:${shopId}:${status ?? 'all'}`;
export const versionListScope = (shopId: string, draftId: string) =>
  `versions:${shopId}:${draftId}`;

/** base64url of `[at, id, checksum]`; the checksum covers position and scope (tamper and reuse detection, not a secret). */
export const encodeDraftCursor = (key: DraftCursorKey, scope: string): string =>
  Buffer.from(
    JSON.stringify([key.at, key.id, digest(`${key.at}|${key.id}|${scope}`)]),
  ).toString('base64url');

/** `null` for anything that is not a cursor issued for exactly this scope. */
export function decodeDraftCursor(
  cursor: string,
  scope: string,
): DraftCursorKey | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 512) return null;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [at, id, check] = value as unknown[];
    if (
      typeof at !== 'string' ||
      typeof id !== 'string' ||
      typeof check !== 'string' ||
      !TIMESTAMP.test(at) ||
      !UUID.test(id)
    )
      return null;
    return check === digest(`${at}|${id}|${scope}`) ? { at, id } : null;
  } catch {
    return null;
  }
}
