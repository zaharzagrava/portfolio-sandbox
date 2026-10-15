import { payoutEventSchemas } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';
import { lazy } from './shared-event';

/**
 * `payouts.events` v1 (specs/domains/S15-payouts/contracts/events.md): key = `payoutId`, ids, amounts and codes only,
 * never the destination or a provider body. Payload schemas come from `packages/contracts`, shared with the consumers
 * (S28, S43, S16). The aggregate version is the row's `payoutVersion` after the update: monotone, not contiguous.
 */
export const PAYOUTS_AGGREGATE: TopicRegistration = {
  aggregateType: 'payouts',
  retention: 'full-history',
};

export const payoutEvents = lazy(() => ({
  created: defineEvent(
    'payout.created',
    'payouts',
    1,
    payoutEventSchemas['payout.created'],
  ),
  paid: defineEvent(
    'payout.paid',
    'payouts',
    1,
    payoutEventSchemas['payout.paid'],
  ),
  failed: defineEvent(
    'payout.failed',
    'payouts',
    1,
    payoutEventSchemas['payout.failed'],
  ),
  cancelled: defineEvent(
    'payout.cancelled',
    'payouts',
    1,
    payoutEventSchemas['payout.cancelled'],
  ),
  inDoubt: defineEvent(
    'payout.in_doubt',
    'payouts',
    1,
    payoutEventSchemas['payout.in_doubt'],
  ),
  discrepancy: defineEvent(
    'payout.discrepancy_detected',
    'payouts',
    1,
    payoutEventSchemas['payout.discrepancy_detected'],
  ),
}));
