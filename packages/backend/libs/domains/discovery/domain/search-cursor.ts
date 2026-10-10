import { createHash } from 'node:crypto';
import { InvalidCursorError } from './search-errors';

export type SortValue = string | number;

/** The last item's sort values and its id (the total-order tiebreaker). */
export interface CursorPosition {
  sv: SortValue[];
  id: string;
}

/** Everything a cursor is bound to (FR-008). */
export interface SearchScope {
  q: string | null;
  filters: Record<string, unknown>;
  sort: string;
  mode: string;
}

const MAX_CURSOR_LENGTH = 1024;
const MAX_SORT_VALUES = 4;
const MAX_VALUE_LENGTH = 128;
const FINGERPRINT_LENGTH = 22; // base64url of 16 bytes
const CHECKSUM_LENGTH = 11; // base64url of 8 bytes

const digest = (text: string, bytes: number): string =>
  createHash('sha256').update(text).digest().subarray(0, bytes).toString('base64url');

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
};

/** Short digest of `(q, filters, sort, mode)`; filter key order does not matter. */
export const searchFingerprint = (scope: SearchScope): string =>
  digest(
    JSON.stringify(stable([scope.q, scope.filters, scope.sort, scope.mode])),
    16,
  );

const isSortValue = (v: unknown): v is SortValue =>
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.length <= MAX_VALUE_LENGTH);

const validPosition = (sv: unknown, id: unknown): sv is SortValue[] =>
  Array.isArray(sv) &&
  sv.length >= 1 &&
  sv.length <= MAX_SORT_VALUES &&
  sv.every(isSortValue) &&
  typeof id === 'string' &&
  id.length >= 1 &&
  id.length <= MAX_VALUE_LENGTH;

const checksum = (sv: SortValue[], id: string, fp: string): string =>
  digest(JSON.stringify([sv, id, fp]), 8);

/**
 * Opaque cursor: base64url of the JSON tuple `[sortValues, id, fingerprint, checksum]` (no field names, no physical
 * index name). Not a secret; the checksum and fingerprint detect tampering and reuse across searches.
 */
export function encodeSearchCursor(
  position: CursorPosition,
  fingerprint: string,
): string {
  if (!validPosition(position.sv, position.id))
    throw new TypeError('invalid cursor position');
  return Buffer.from(
    JSON.stringify([
      position.sv,
      position.id,
      fingerprint,
      checksum(position.sv, position.id, fingerprint),
    ]),
  ).toString('base64url');
}

/** Throws `InvalidCursorError` (422 invalid_cursor) for anything not issued for exactly this fingerprint. */
export function decodeSearchCursor(
  cursor: string,
  fingerprint: string,
): CursorPosition {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > MAX_CURSOR_LENGTH)
    throw new InvalidCursorError();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (!Array.isArray(value) || value.length !== 4)
    throw new InvalidCursorError();
  const [sv, id, fp, check] = value as unknown[];
  if (
    !validPosition(sv, id) ||
    typeof fp !== 'string' ||
    fp.length !== FINGERPRINT_LENGTH ||
    typeof check !== 'string' ||
    check.length !== CHECKSUM_LENGTH ||
    check !== checksum(sv, id as string, fp) ||
    fp !== fingerprint
  )
    throw new InvalidCursorError();
  return { sv, id: id as string };
}
