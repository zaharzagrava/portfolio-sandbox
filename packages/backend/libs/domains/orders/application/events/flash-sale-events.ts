import { createHash } from 'node:crypto';
import { flashSaleEventSchemas } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';

/**
 * `orders.events` keyed by `saleId` (specs/domains/S11-flash-sales/contracts/events.md): one topic per domain, so the
 * aggregate type stays `orders` and the sale id is the aggregate id. Payload schemas live in `packages/contracts`.
 * Wire types are `flashsale.<name>` (the spec's `flash_sale.<name>`): S53 allows no `_` in the first segment of a type.
 */
export const FlashSaleLoaded = defineEvent(
  'flashsale.loaded',
  'orders',
  1,
  flashSaleEventSchemas['flashsale.loaded'],
);
export const FlashSaleEnded = defineEvent(
  'flashsale.ended',
  'orders',
  1,
  flashSaleEventSchemas['flashsale.ended'],
);
export const FlashSaleReconciled = defineEvent(
  'flashsale.reconciled',
  'orders',
  1,
  flashSaleEventSchemas['flashsale.reconciled'],
);
export const FlashSaleCancelled = defineEvent(
  'flashsale.cancelled',
  'orders',
  1,
  flashSaleEventSchemas['flashsale.cancelled'],
);
export const FlashSaleStartFailed = defineEvent(
  'flashsale.start_failed',
  'orders',
  1,
  flashSaleEventSchemas['flashsale.start_failed'],
);
export const FlashSaleSoldOut = defineEvent(
  'flashsale.sold_out',
  'orders',
  1,
  flashSaleEventSchemas['flashsale.sold_out'],
);
export const FlashSaleOversold = defineEvent(
  'flashsale.oversold',
  'orders',
  1,
  flashSaleEventSchemas['flashsale.oversold'],
);

/**
 * Same event id for a repeated `(type, saleId[, sequence])`, so a second delivery of the same fact is recognisable.
 * The envelope wants a UUIDv7-shaped id: the hash of the three parts, with the version and variant bits of a v7.
 */
export function withDeterministicId<T extends EventEnvelope>(
  envelope: T,
  sequence?: number,
): T {
  const hex = createHash('sha256')
    .update(
      `${envelope.type}|${envelope.aggregateId}${sequence === undefined ? '' : `|${sequence}`}`,
    )
    .digest('hex');
  const variant = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4];
  const eventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { ...envelope, eventId };
}
