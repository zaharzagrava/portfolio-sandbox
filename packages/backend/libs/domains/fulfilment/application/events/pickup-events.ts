import {
  pickupPointChangedPayloadSchema,
  pickupStockChangedPayloadSchema,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/** `pickup.events` (key = aggregate id): the full state of a stock row or a point after every effective change. */
export const PICKUP_AGGREGATE: TopicRegistration = {
  aggregateType: 'pickup',
  retention: 'full-history',
};

/**
 * Aggregate id = `<pickupPointId>:<productId>`, `aggregateVersion` = the row `version` (also `payload.stockVersion`).
 * `quantity` is the absolute stock of one (point, product): the latest event is the full state, so consumers may
 * coalesce. The envelope's contract version stays 1; the row version never goes into it (S19 A18).
 */
export const PickupStockChanged = defineEvent(
  'pickup.stock_changed',
  'pickup',
  1,
  pickupStockChangedPayloadSchema,
  { carries: 'state' },
);

/** Aggregate id = `pickupPointId`, `aggregateVersion` = the point `version` (also `payload.pointVersion`). */
export const PickupPointChanged = defineEvent(
  'pickup.point_changed',
  'pickup',
  1,
  pickupPointChangedPayloadSchema,
  { carries: 'state' },
);
