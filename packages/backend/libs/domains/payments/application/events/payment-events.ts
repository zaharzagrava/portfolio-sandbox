import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * `payments.events` (key = the payment request's idempotency key). Transitional carrier of the former
 * `payments.responses` message: `payload` is the original request, `extra.payment` the resulting payment, `error`
 * the failure if any. `aggregateVersion` is the step of the payment's story (1 = decided, 2 = refunded). S13 replaces
 * this with typed `payments.*` events and `appendTask` for the request/response hop.
 */
export const PaymentProcessed = defineEvent(
  'payment.processed',
  'payments',
  1,
  z.object({
    payload: z.unknown(),
    extra: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
);

export const PAYMENTS_AGGREGATE: TopicRegistration = {
  aggregateType: 'payments',
  retention: 'full-history',
};
