import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';
import { InvalidCursorError } from './payment-errors';

/**
 * Keyset cursors of the payout lists (S15 contracts/http.md): the ledger's signed `base64url(json).signature` format
 * with the route inside the signed payload, so a cursor issued for one list cannot be replayed on another. A
 * tampered, unsigned or foreign cursor answers `400 invalid_cursor`.
 */
export type PayoutCursorRoute = 'seller' | 'admin' | 'runs';

export interface PayoutCursor {
  r: PayoutCursorRoute;
  /** The sort key: `periodStart` (seller, runs) or `createdAt` (admin). */
  k: string;
  /** Row id; absent for the runs list, which is keyed by period alone. */
  id?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isPayoutCursor = (v: unknown): v is PayoutCursor => {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as PayoutCursor;
  if (c.r !== 'seller' && c.r !== 'admin' && c.r !== 'runs') return false;
  if (typeof c.k !== 'string' || Number.isNaN(Date.parse(c.k))) return false;
  if (c.r === 'runs') return c.id === undefined;
  return typeof c.id === 'string' && UUID.test(c.id);
};

export const encodePayoutCursor = (
  cursor: PayoutCursor,
  secret: string,
): string => encodeLedgerCursor(cursor, secret);

export function decodePayoutCursor(
  raw: unknown,
  route: PayoutCursorRoute,
  secret: string,
): PayoutCursor {
  const cursor = decodeLedgerCursor(raw, secret, isPayoutCursor);
  if (cursor.r !== route) throw new InvalidCursorError();
  return cursor;
}
