import { isCooling } from './destination';
import type { PayoutPlan } from './reserve';

/** Why a shop gets no payout this week. The gate order below is the reason precedence. */
export type SkipReason =
  | 'below_minimum'
  | 'payouts_disabled'
  | 'shop_not_active'
  | 'shop_unknown'
  | 'destination_missing'
  | 'destination_cooling'
  | 'insufficient_balance'
  | 'ledger_busy';

export type UpcomingBlockedReason =
  | 'payouts_disabled'
  | 'destination_missing'
  | 'destination_cooling'
  | 'below_minimum';

export interface EligibilityFacts {
  /** Tenancy answered for this shop. */
  known: boolean;
  status: string | undefined;
  payoutsEnabled: boolean;
  destination: { effectiveFrom: Date } | null;
  now: Date;
}

export type Eligibility = { ok: true } | { ok: false; reason: SkipReason };

/** Gates in order: unknown, not active, payouts disabled, no destination, destination cooling. */
export function assessEligibility(facts: EligibilityFacts): Eligibility {
  if (!facts.known) return { ok: false, reason: 'shop_unknown' };
  if (facts.status !== 'ACTIVE')
    return { ok: false, reason: 'shop_not_active' };
  if (!facts.payoutsEnabled) return { ok: false, reason: 'payouts_disabled' };
  if (!facts.destination) return { ok: false, reason: 'destination_missing' };
  if (isCooling(facts.destination.effectiveFrom, facts.now))
    return { ok: false, reason: 'destination_cooling' };
  return { ok: true };
}

/**
 * What the seller is told about the next payout. A shop that is unknown, not active or disabled all read
 * `payouts_disabled` (a seller is not told internal status codes); then destination, then the minimum.
 */
export function blockedReason(
  facts: EligibilityFacts,
  plan: PayoutPlan,
): UpcomingBlockedReason | null {
  const gate = assessEligibility(facts);
  if (!gate.ok) {
    switch (gate.reason) {
      case 'destination_missing':
      case 'destination_cooling':
        return gate.reason;
      default:
        return 'payouts_disabled';
    }
  }
  return plan.kind === 'skip' ? 'below_minimum' : null;
}
