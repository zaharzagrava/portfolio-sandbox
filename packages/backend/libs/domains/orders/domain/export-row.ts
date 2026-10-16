import { InvalidCursorError } from './order-errors';

/** One CSV line of the export; money stays a decimal string (never `Number`). */
export interface ExportRow {
  orderId: string;
  shopOrderId: string;
  /** The shop order's creation time. */
  createdAt: Date;
  shopOrderStatus: string;
  currency: string;
  productId: string;
  sku: string | null;
  title: string;
  quantity: number;
  unitPriceMinor: string;
  discountMinor: string;
  lineTotalMinor: string;
}

/** A line as the order store holds it: snapshot columns may still be null on legacy rows (S10 backfill). */
export type RawExportRow = Omit<
  ExportRow,
  'sku' | 'title' | 'lineTotalMinor'
> & {
  title: string | null;
  lineTotalMinor: string | null;
};

/** Keyset position of the line read: (shop order createdAt ISO ms, shop order id, line id). */
export interface KeysetPosition {
  createdAt: string;
  shopOrderId: string;
  lineId: string;
}

/** Opaque list cursor `{createdAt, id}` as base64url JSON. */
export interface ExportListCursor {
  createdAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeExportCursor(cursor: ExportListCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }),
  ).toString('base64url');
}

/** Strict parse: exactly the two keys, an ISO-ms instant and a UUID; anything else is `invalid_cursor`. */
export function decodeExportCursor(raw: string): ExportListCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new InvalidCursorError();
  const keys = Object.keys(parsed).sort();
  const { createdAt, id } = parsed as Record<string, unknown>;
  if (
    keys.length !== 2 ||
    keys[0] !== 'createdAt' ||
    keys[1] !== 'id' ||
    typeof createdAt !== 'string' ||
    typeof id !== 'string' ||
    !ISO_MS.test(createdAt) ||
    Number.isNaN(Date.parse(createdAt)) ||
    !UUID.test(id)
  )
    throw new InvalidCursorError();
  return { createdAt, id };
}

/** Legacy fallback: a line without a title snapshot takes the catalog title. */
export const resolveTitle = (
  title: string | null,
  catalogTitle: string | null | undefined,
): string => title ?? catalogTitle ?? '';

/** Legacy fallback: a line without a total is `quantity * unitPrice - discount`, in BigInt. */
export function resolveLineTotalMinor(
  lineTotalMinor: string | null,
  quantity: number,
  unitPriceMinor: string,
  discountMinor: string,
): string {
  if (lineTotalMinor !== null) return lineTotalMinor;
  return (
    BigInt(quantity) * BigInt(unitPriceMinor) -
    BigInt(discountMinor)
  ).toString();
}
