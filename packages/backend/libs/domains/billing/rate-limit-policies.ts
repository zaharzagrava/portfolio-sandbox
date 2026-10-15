import { applyDecorators } from '@nestjs/common';
import type { Request } from 'express';
import {
  RateLimit,
  definePolicies,
  type PolicyNamesOf,
  type RateLimitPolicyName,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `billing` (S17 FR-014, FR-038; S50): registered by `BillingModule`. Money-moving and
 * card-testing routes fail closed; the public catalog is cached data and fails open. The "subject" is the shop on
 * shop routes and the user on `/me` routes (`custom` key, see `billingSubject`).
 */
export const billingRatePolicies = definePolicies('billing', {
  'billing.subscribe.subject': {
    algorithm: 'slidingWindow',
    limit: 10,
    windowMs: 3_600_000,
    key: 'custom',
    failMode: 'closed',
  },
  'billing.change.subject': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: 3_600_000,
    key: 'custom',
    failMode: 'closed',
  },
  'billing.preview.subject': {
    algorithm: 'slidingWindow',
    limit: 60,
    windowMs: 60_000,
    key: 'custom',
    failMode: 'closed',
  },
  'billing.payment-method.subject': {
    algorithm: 'slidingWindow',
    limit: 5,
    windowMs: 3_600_000,
    key: 'custom',
    failMode: 'closed',
  },
  // S18: the usage reads hit the analytical store; 60 a minute per subject, and a limiter that is down refuses
  'billing.usage-read.subject': {
    algorithm: 'slidingWindow',
    limit: 60,
    windowMs: 60_000,
    key: 'custom',
    failMode: 'closed',
  },
  'billing.plans.ip': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof billingRatePolicies.policies
  > {}
}

/** `shop:<id>` on shop routes (set by `ShopScoped`), `user:<id>` on `/me` routes; nothing falls back to the address. */
export const billingSubject = (req: Request): string | null => {
  const scoped = req as Request & { shopId?: string; user?: { id?: string } };
  if (scoped.shopId) return `shop:${scoped.shopId}`;
  return scoped.user?.id ? `user:${scoped.user.id}` : null;
};

/** `@BillingRateLimit('billing.change.subject')`: the policy keyed by the shop or the user of the route. */
export const BillingRateLimit = (policy: RateLimitPolicyName) =>
  applyDecorators(RateLimit({ policy, subject: billingSubject }));
