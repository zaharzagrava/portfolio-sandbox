import {
  invalidCurrentValue,
  notALimit,
  notAQuota,
  unknownEntitlement,
} from './errors';
import type { SubjectType } from './types';

/**
 * What a plan allows, as callers ask for it (S18 FR-001 to FR-006). Plans are never named: a caller asks about a
 * feature or a limit. The key list is closed; anything else is rejected, never answered `false`.
 */
export const ENTITLEMENT_KEYS = [
  'freeShipping',
  'earlyAccessDrops',
  'maxProducts',
  'seats',
  'auctions',
  'apiCallsPerMonth',
  'assistantTokensPerMonth',
  'maxCompetitorWatches',
] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

/**
 * Count limits (`checkLimit`): the caller holds the current count. `maxCompetitorWatches` is S41's (competitor price
 * monitor): the free tier and any plan without the key allow 0.
 */
export const LIMIT_KEYS = [
  'maxProducts',
  'seats',
  'maxCompetitorWatches',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** Monthly quotas (`checkQuota`) and the usage metric that counts each (FR-006). */
export const QUOTA_METRICS = {
  apiCallsPerMonth: 'api.calls',
  assistantTokensPerMonth: 'llm.assistant.tokens',
} as const;
export type QuotaKey = keyof typeof QUOTA_METRICS;

export interface Entitlements {
  freeShipping?: boolean;
  earlyAccessDrops?: boolean;
  maxProducts?: number;
  seats?: number;
  auctions?: boolean;
  apiCallsPerMonth?: number;
  assistantTokensPerMonth?: number;
  maxCompetitorWatches?: number;
}

/** Free tier when there is no live subscription (S18 owns it, FR-002). */
export const FREE_SHOP: Readonly<Entitlements> = Object.freeze({
  maxProducts: 10,
  seats: 1,
  auctions: false,
  apiCallsPerMonth: 1000,
  assistantTokensPerMonth: 0,
});
/**
 * S46 reads `assistantTokensPerMonth` for every buyer and has no local default, so the free buyer tier carries it
 * (research R-2; deviation from DS-1, recorded in gaps.md).
 */
export const FREE_BUYER: Readonly<Entitlements> = Object.freeze({
  assistantTokensPerMonth: 200_000,
});

/** A fresh copy: a caller may do what it likes with its answer. */
export const freeTier = (subjectType: SubjectType): Entitlements => ({
  ...(subjectType === 'SHOP' ? FREE_SHOP : FREE_BUYER),
});

export const isEntitlementKey = (key: unknown): key is EntitlementKey =>
  typeof key === 'string' &&
  (ENTITLEMENT_KEYS as readonly string[]).includes(key);

/** Rejects `unknown_entitlement` for a key outside the closed list. */
export function assertEntitlementKey(
  key: unknown,
): asserts key is EntitlementKey {
  if (!isEntitlementKey(key)) throw unknownEntitlement(String(key));
}

const valueOf = (entitlements: Entitlements, key: EntitlementKey) =>
  Object.prototype.hasOwnProperty.call(entitlements, key)
    ? entitlements[key]
    : undefined;

/** FR-003: a boolean key is present when `true`, a numeric key when greater than 0, a missing key is absent. */
export function hasEntitlement(
  entitlements: Entitlements,
  key: string,
): boolean {
  assertEntitlementKey(key);
  const value = valueOf(entitlements, key);
  if (typeof value === 'boolean') return value;
  return typeof value === 'number' && value > 0;
}

/** FR-005: `allowed` means "one more is permitted" (`current < limit`); a missing limit is 0. */
export function checkLimit(
  entitlements: Entitlements,
  key: string,
  current: number,
): { allowed: boolean; limit: number; remaining: number } {
  assertEntitlementKey(key);
  if (!(LIMIT_KEYS as readonly string[]).includes(key)) throw notALimit(key);
  if (
    typeof current !== 'number' ||
    !Number.isSafeInteger(current) ||
    current < 0
  )
    throw invalidCurrentValue();
  const value = valueOf(entitlements, key);
  const limit = typeof value === 'number' && value > 0 ? value : 0;
  return {
    allowed: current < limit,
    limit,
    remaining: Math.max(0, limit - current),
  };
}

/** The usage metric of a quota key; `unknown_entitlement` for an unknown key, `not_a_quota` for another known key. */
export function quotaMetric(key: string): string {
  assertEntitlementKey(key);
  if (!Object.prototype.hasOwnProperty.call(QUOTA_METRICS, key))
    throw notAQuota(key);
  return QUOTA_METRICS[key as QuotaKey];
}

/** The numeric limit of a quota key in a set of entitlements (0 when the subject lacks it). */
export function quotaLimit(entitlements: Entitlements, key: QuotaKey): number {
  const value = valueOf(entitlements, key);
  return typeof value === 'number' && value > 0 ? value : 0;
}
