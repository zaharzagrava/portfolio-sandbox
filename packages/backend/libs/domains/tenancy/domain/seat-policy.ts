import type { ShopPlan } from './shop-types';

const SEATS: Record<ShopPlan, number> = {
  STARTER: 5,
  PRO: 25,
  ENTERPRISE: 250,
};

/** Seats include members and pending invites (FR-031). Lowering a plan removes nobody; it only blocks new seats. */
export const seatLimit = (plan: ShopPlan): number => SEATS[plan];

export const hasFreeSeat = (
  plan: ShopPlan,
  members: number,
  pendingInvites: number,
): boolean => members + pendingInvites < SEATS[plan];

/** Owned shops per user (FR-002). */
export const MAX_OWNED_SHOPS = 10;
