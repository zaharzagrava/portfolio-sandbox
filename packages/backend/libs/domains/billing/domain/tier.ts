import {
  ENTITLED_STATUSES,
  type SubscriptionStatus,
} from './subscription-status';
import type { PlanTier } from './types';

const TIER_BY_CODE: Record<string, PlanTier> = {
  starter: 'STARTER',
  pro: 'PRO',
  enterprise: 'ENTERPRISE',
};

/** The tier a shop plan code stands for; `null` for a code that is not a shop tier (e.g. a buyer plan). */
export const tierOfPlanCode = (code: string): PlanTier | null =>
  TIER_BY_CODE[code] ?? null;

/**
 * The effective tier of a shop (S17 FR-020): the live subscription's plan while it is `TRIALING`, `ACTIVE` or
 * `PAST_DUE`, and `STARTER` otherwise (`UNPAID`, `CANCELED`, none).
 */
export function effectiveTier(
  status: SubscriptionStatus | null,
  planCode: string | null,
): PlanTier {
  if (status === null || planCode === null) return 'STARTER';
  if (!ENTITLED_STATUSES.includes(status)) return 'STARTER';
  return tierOfPlanCode(planCode) ?? 'STARTER';
}
