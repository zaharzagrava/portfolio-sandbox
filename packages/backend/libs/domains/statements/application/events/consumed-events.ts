import { z } from 'zod';
import type { EventDefinition } from '@app/infrastructure/events/define-event';
import { topicFor } from '@app/infrastructure/events/event-envelope';

/**
 * The events statements consumes, as the consumer framework sees them: type, version and topic, and a schema that
 * lets any object through. The statements validate a payload themselves (`domain/order-paid-fact.ts`, the contract
 * schemas of S14 and S15), because each refusal must name its own reason on `statements_events_rejected_total` and
 * the shared producer definitions strip fields (`lineId`, `category`) the producer's schema does not list yet. These
 * definitions are deliberately not registered: the producing domain owns the registered ones (one per process).
 */
function consumed(
  type: string,
  aggregateType: string,
  version: number,
): EventDefinition<string, string, z.ZodType> {
  const schema = z.looseObject({});
  return {
    type,
    version,
    aggregateType,
    topic: topicFor(aggregateType),
    schema,
    carries: 'delta',
    create() {
      throw new Error(`${type} is consumed by statements, never produced`);
    },
    match(envelope) {
      return envelope.type === type && envelope.version === version
        ? { ...envelope, payload: schema.parse(envelope.payload) }
        : null;
    },
  };
}

export const ORDER_PAID_TOPIC = topicFor('orders');
export const PAYOUTS_TOPIC = topicFor('payouts');
export const LEDGER_TOPIC = topicFor('ledger');

export const consumedOrderPaid = consumed('order.paid', 'orders', 1);
export const consumedPayoutPaid = consumed('payout.paid', 'payouts', 1);
export const consumedJournalPosted = consumed(
  'ledger.journal_posted',
  'ledger',
  2,
);
/** v1 carried deltas without balances; it is not lifted to v2, the projector skips and counts it. */
export const LEGACY_JOURNAL_MARK = { __legacyV1: true } as const;
