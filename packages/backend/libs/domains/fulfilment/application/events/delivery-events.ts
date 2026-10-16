import { deliveryStatusChangedPayloadSchema } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/** `delivery.events` (key = `deliveryId`): one event per milestone, none for offer churn (S20 FR-028). */
export const DELIVERY_AGGREGATE: TopicRegistration = {
  aggregateType: 'delivery',
  retention: 'full-history',
};

/** Aggregate id = `deliveryId`, `aggregateVersion` = `Delivery.version` (also `payload.deliveryVersion`). */
export const DeliveryStatusChanged = defineEvent(
  'delivery.status_changed',
  'delivery',
  1,
  deliveryStatusChangedPayloadSchema,
);
