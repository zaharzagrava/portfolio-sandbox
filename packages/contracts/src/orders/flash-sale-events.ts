import { z } from 'zod';
import { flashStatusReasonSchema } from './flash-sale.ts';

/**
 * `orders.events` payloads of S11 (specs/domains/S11-flash-sales/contracts/events.md); topic key is `saleId`.
 *
 * Wire types are `flashsale.<name>`: the platform's event-type pattern (S53, `EVENT_TYPE_PATTERN`) allows no `_` in the
 * first segment, so the spec's `flash_sale.<name>` cannot be registered. `FLASH_SALE_EVENT_ALIASES` maps the name used in
 * the spec to the wire type (same approach as S28's `CONSUMED_EVENT_ALIASES`).
 */
const units = z.number().int().nonnegative();
const base = {
  saleId: z.string().uuid(),
  shopId: z.string().uuid(),
  productId: z.string().uuid(),
};

export const flashSaleEventSchemas = {
  'flashsale.loaded': z.object({
    ...base,
    units: z.number().int().positive(),
    buckets: z.number().int().positive(),
    startsAt: z.string(),
    endsAt: z.string(),
  }),
  'flashsale.ended': z.object(base),
  'flashsale.reconciled': z.object({
    ...base,
    units: z.number().int().positive(),
    unitsSold: units,
    unitsReturned: units,
    driftUnits: z.number().int(),
  }),
  'flashsale.cancelled': z.object(base),
  'flashsale.start_failed': z.object({
    ...base,
    reason: flashStatusReasonSchema,
  }),
  'flashsale.sold_out': z.object(base),
  'flashsale.oversold': z.object({
    ...base,
    excessUnits: z.number().int().positive(),
    cancelledOrderIds: z.array(z.string().uuid()),
    unresolvedPaidUnits: units,
  }),
} as const;

export type FlashSaleEventType = keyof typeof flashSaleEventSchemas;

/** The spec's name of each event → the type on the wire. */
export const FLASH_SALE_EVENT_ALIASES = {
  'flash_sale.loaded': 'flashsale.loaded',
  'flash_sale.ended': 'flashsale.ended',
  'flash_sale.reconciled': 'flashsale.reconciled',
  'flash_sale.cancelled': 'flashsale.cancelled',
  'flash_sale.start_failed': 'flashsale.start_failed',
  'flash_sale.sold_out': 'flashsale.sold_out',
  'flash_sale.oversold': 'flashsale.oversold',
} as const satisfies Record<string, FlashSaleEventType>;
