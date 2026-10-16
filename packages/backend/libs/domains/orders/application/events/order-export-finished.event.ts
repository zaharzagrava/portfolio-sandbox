import { orderExportEventSchemas } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * Topic of the order export (S12 contracts/async.md). The spec names it `order-exports.events`, but the topic registry
 * only accepts aggregate types matching `^[a-z][a-z0-9_]*$` (topic = `<aggregateType>.events`), so the aggregate is
 * `order_exports` and the topic `order_exports.events`. Register it with `EventsModule.forAggregates`.
 */
export const ORDER_EXPORT_AGGREGATE = {
  aggregateType: 'order_exports',
  retention: 'full-history',
} as const;

/**
 * The spec's `order_export.finished` v1, key `exportId`: exactly one per export, appended in the final-status
 * transaction (DONE, FAILED, CANCELLED). The event-type pattern (`EVENT_TYPE_PATTERN`, S53 FR-007) forbids an
 * underscore in the first segment, so the wire type is `orderexport.finished` (as S11's `flashsale.*`).
 */
export const OrderExportFinished = defineEvent(
  'orderexport.finished',
  ORDER_EXPORT_AGGREGATE.aggregateType,
  1,
  orderExportEventSchemas['orderexport.finished'],
);
