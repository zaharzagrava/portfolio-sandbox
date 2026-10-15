import { statementsEventSchemas } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * `statements.events` v1 (specs/domains/S16-seller-statements/contracts/events.md): `statements.period_closed` keyed
 * by the month, `statements.adjustment_booked` keyed by the adjustment id. Schemas come from `packages/contracts`,
 * shared with the consumers (S28, J01). Ids, months and amounts only: no buyer identifier.
 */
export const STATEMENTS_AGGREGATE: TopicRegistration = {
  aggregateType: 'statements',
  retention: 'full-history',
};

export const PeriodClosed = defineEvent(
  'statements.period_closed',
  'statements',
  1,
  statementsEventSchemas['statements.period_closed'],
);

export const AdjustmentBooked = defineEvent(
  'statements.adjustment_booked',
  'statements',
  1,
  statementsEventSchemas['statements.adjustment_booked'],
);
