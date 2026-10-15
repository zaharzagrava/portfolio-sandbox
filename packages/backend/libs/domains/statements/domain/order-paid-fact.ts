import { MAX_LINE_TOTAL_MINOR } from '@marketplace-sandbox/contracts';

/**
 * The statements' own reading of an `order.paid` payload (S16 contracts/events.md "Consumed"). It picks the fields it
 * keeps and nothing else (a buyer identifier, a title or any field added later is never read, let alone stored), and
 * names the first reason it refuses a payload with. The reasons are the dead-letter reasons of
 * `statements_events_rejected_total{stream,reason}`.
 */
export type OrderPaidRejection =
  | 'invalid_payload'
  | 'missing_line_id'
  | 'missing_shop'
  | 'currency_not_eur'
  | 'line_total_mismatch'
  | 'amount_too_large';

export interface SaleLine {
  lineId: string;
  productId: string;
  shopId: string;
  category: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  lineTotalMinor: number;
}

export interface OrderPaidFact {
  orderId: string;
  orderVersion: number;
  paidAt: Date;
  lines: SaleLine[];
}

export type OrderPaidResult =
  { ok: true; fact: OrderPaidFact } | { ok: false; reason: OrderPaidRejection };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const fail = (reason: OrderPaidRejection): OrderPaidResult => ({
  ok: false,
  reason,
});
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isMoney = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export const normaliseCategory = (value: string): string =>
  value.trim().toLowerCase();

export function parseOrderPaid(payload: unknown): OrderPaidResult {
  if (!isRecord(payload)) return fail('invalid_payload');
  const { orderId, orderVersion, paidAt, currency, lines } = payload;
  if (typeof orderId !== 'string' || !UUID.test(orderId))
    return fail('invalid_payload');
  if (
    typeof orderVersion !== 'number' ||
    !Number.isSafeInteger(orderVersion) ||
    orderVersion < 1
  )
    return fail('invalid_payload');
  if (
    typeof paidAt !== 'string' ||
    !ISO_WITH_OFFSET.test(paidAt) ||
    Number.isNaN(Date.parse(paidAt))
  )
    return fail('invalid_payload');
  if (!Array.isArray(lines)) return fail('invalid_payload');

  const parsed: SaleLine[] = [];
  let reason: OrderPaidRejection | null = null;
  for (const raw of lines) {
    if (!isRecord(raw)) return fail('invalid_payload');
    if (typeof raw.lineId !== 'string' || raw.lineId.length === 0)
      return fail('missing_line_id');
    if (typeof raw.shopId !== 'string' || !UUID.test(raw.shopId))
      return fail('missing_shop');
    const { quantity, unitPriceMinor, discountMinor, lineTotalMinor } = raw;
    if (
      typeof quantity !== 'number' ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      !isMoney(unitPriceMinor) ||
      !isMoney(discountMinor) ||
      !isMoney(lineTotalMinor)
    )
      return fail('invalid_payload');
    if (typeof raw.productId !== 'string' || raw.productId.length === 0)
      return fail('invalid_payload');
    const category =
      typeof raw.category === 'string' ? normaliseCategory(raw.category) : '';
    if (category.length < 1 || category.length > 64)
      return fail('invalid_payload');
    if (currency !== 'EUR') reason ??= 'currency_not_eur';
    if (lineTotalMinor !== quantity * unitPriceMinor - discountMinor)
      reason ??= 'line_total_mismatch';
    if (lineTotalMinor > MAX_LINE_TOTAL_MINOR) reason ??= 'amount_too_large';
    parsed.push({
      lineId: raw.lineId,
      productId: raw.productId,
      shopId: raw.shopId.toLowerCase(),
      category,
      quantity,
      unitPriceMinor,
      discountMinor,
      lineTotalMinor,
    });
  }
  if (lines.length === 0 && currency !== 'EUR') reason ??= 'currency_not_eur';
  if (reason) return fail(reason);
  return {
    ok: true,
    fact: {
      orderId: orderId.toLowerCase(),
      orderVersion,
      paidAt: new Date(paidAt),
      lines: parsed,
    },
  };
}
