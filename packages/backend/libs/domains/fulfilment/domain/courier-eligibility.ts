import type { CourierStatus } from '@marketplace-sandbox/contracts';

/** An `AVAILABLE` courier whose newest accepted point is older than this is not offered anything (FR-014, A11). */
export const POSITION_MAX_AGE_MS = 60_000;

export interface EligibilityFacts {
  courierId: string;
  /** Stored status (Postgres), not the cache. */
  status: CourierStatus;
  /** Epoch ms of the newest accepted point; `null` when the courier never reported one. */
  positionTs: number | null;
  /** The courier holds an `OFFERED` record. */
  hasLiveOffer: boolean;
}

/**
 * Pure eligibility for one delivery: `AVAILABLE`, position at most 60 s old (exactly 60 s is eligible), no live offer,
 * and not offered this delivery before (`offeredBefore` = every courier with an offer record for it). `now` is epoch ms.
 */
export function isEligible(
  courier: EligibilityFacts,
  now: number,
  offeredBefore: ReadonlySet<string>,
): boolean {
  return (
    courier.status === 'AVAILABLE' &&
    courier.positionTs !== null &&
    now - courier.positionTs <= POSITION_MAX_AGE_MS &&
    !courier.hasLiveOffer &&
    !offeredBefore.has(courier.courierId)
  );
}
