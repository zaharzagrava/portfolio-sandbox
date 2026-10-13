import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidCursorError } from './payment-errors';

/**
 * Opaque, tamper-evident keyset cursors of the ledger lists (S14 contracts/http.md): `base64url(json).signature`,
 * HMAC-SHA256 with `LEDGER_CURSOR_SECRET`. A cursor that was not issued by this service answers `invalid_cursor`.
 */
const sign = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export function encodeLedgerCursor(value: unknown, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeLedgerCursor<T>(
  raw: unknown,
  secret: string,
  isValid: (value: unknown) => value is T,
): T {
  if (typeof raw !== 'string') throw new InvalidCursorError();
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined)
    throw new InvalidCursorError();
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    throw new InvalidCursorError();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    throw new InvalidCursorError();
  }
  if (!isValid(value)) throw new InvalidCursorError();
  return value;
}

/** `(time, id)` keyset position of the runs and issues lists. */
export interface TimeCursor {
  t: string;
  id: string;
}

export const isTimeCursor = (v: unknown): v is TimeCursor =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as TimeCursor).t === 'string' &&
  !Number.isNaN(new Date((v as TimeCursor).t).getTime()) &&
  typeof (v as TimeCursor).id === 'string' &&
  /^[0-9a-f-]{36}$/i.test((v as TimeCursor).id);

/** Keyset position of `listSellerBalances`: the last account id of the previous page. */
export interface AccountCursor {
  a: string;
}

export const isAccountCursor = (v: unknown): v is AccountCursor =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as AccountCursor).a === 'string' &&
  /^SHOP_[0-9a-f-]{36}$/.test((v as AccountCursor).a);
