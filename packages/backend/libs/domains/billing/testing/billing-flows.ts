import { v4 as uuidv4 } from 'uuid';
import {
  subscriptionSchema,
  type SubscriptionDto,
} from '@marketplace-sandbox/contracts';
import type { TestUser } from '@app/test/utils/catalog-app';
import type { BillingTestApp } from './billing-app';

/**
 * Flows the billing specs share, built only from the public routes (S17 test-plan.md): subscriptions reach a state
 * through their real triggers. Privileged statements (`aged`) are used solely where a scenario says so.
 */
export interface Fixture {
  shopId: string;
  owner: TestUser;
  subscriptionId: string;
  subscription: SubscriptionDto;
}

export const key = () => uuidv4();

/** Fails with the response body when the status is not the expected one (a bare `toBe` hides the problem). */
export function expectStatus(
  res: { status: number; body: unknown },
  status: number,
): void {
  if (res.status !== status)
    throw new Error(
      `expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
}

/** `POST /shops/:shopId/subscription` as `who`, with a fresh idempotency key unless given. */
export const subscribeShop = (
  t: BillingTestApp,
  who: TestUser,
  shopId: string,
  body: Record<string, unknown>,
  idempotencyKey: string | null = key(),
) => {
  let req = t.as(who).post(`/api/shops/${shopId}/subscription`);
  if (idempotencyKey !== null) req = req.set('Idempotency-Key', idempotencyKey);
  return req.send(body);
};

export const subscribeBuyer = (
  t: BillingTestApp,
  who: TestUser,
  body: Record<string, unknown>,
  idempotencyKey: string | null = key(),
) => {
  let req = t.as(who).post('/api/me/subscription');
  if (idempotencyKey !== null) req = req.set('Idempotency-Key', idempotencyKey);
  return req.send(body);
};

/**
 * Fixture subscription FS (spec.md DS-1): a shop with owner, `starter`, quantity 1, `ACTIVE`, period
 * `2026-04-01T00:00:00Z -> 2026-05-01T00:00:00Z`, paid with `pm_ok`, version 0. It is bought through the API at
 * the first instant and its first charge is run, so the first invoice is `PAID`.
 */
export async function createFs(
  t: BillingTestApp,
  options: {
    plan?: 'starter' | 'pro';
    quantity?: number;
    paymentMethodRef?: string;
    at?: string;
    /** Run the first charge (default true). */
    charge?: boolean;
    owner?: TestUser;
    shopId?: string;
  } = {},
): Promise<Fixture> {
  t.clock.set(new Date(options.at ?? '2026-04-01T00:00:00.000Z'));
  const made = options.shopId
    ? { shopId: options.shopId, owner: options.owner as TestUser }
    : await t.shopWithOwner(options.owner);
  await t.reauth(made.owner);
  const res = await subscribeShop(t, made.owner, made.shopId, {
    priceId: await t.priceId(options.plan ?? 'starter'),
    quantity: options.quantity ?? 1,
    paymentMethodRef: options.paymentMethodRef ?? 'pm_ok',
  });
  if (res.status !== 201)
    throw new Error(
      `FS subscribe answered ${res.status}: ${JSON.stringify(res.body)}`,
    );
  const subscription = subscriptionSchema.parse(res.body);
  if (options.charge !== false) await t.drainJobs();
  return {
    ...made,
    subscriptionId: subscription.id,
    subscription,
  };
}

/** Privileged: sets a subscription's period (aging it), as the one thing a spec cannot reach through a trigger. */
export const aged = (
  t: BillingTestApp,
  subscriptionId: string,
  start: string,
  end: string,
) =>
  t.sequelize.query(
    `UPDATE "Subscription" SET "currentPeriodStart" = :start, "currentPeriodEnd" = :end WHERE "id" = :subscriptionId`,
    { replacements: { subscriptionId, start, end } },
  );

/** Publishes a price through the operator API and returns it (`T14`, `F1000`, `F2000` of DS-1). */
export async function publishPrice(
  t: BillingTestApp,
  admin: TestUser,
  plan: string,
  body: Record<string, unknown>,
): Promise<{ id: string; version: number }> {
  const [row] = await t.sql<{ id: string }>(
    `SELECT id FROM "Plan" WHERE code = :plan`,
    { plan },
  );
  const res = await t
    .as(admin)
    .post(`/api/admin/billing/plans/${row.id}/prices`)
    .send(body);
  if (res.status !== 201)
    throw new Error(
      `publish price answered ${res.status}: ${JSON.stringify(res.body)}`,
    );
  return res.body;
}

export const T14_BODY = {
  interval: 'MONTH',
  unitAmountMinor: 1900,
  perSeat: true,
  trialDays: 14,
  includedUsage: { 'api.calls': 10000 },
  overagePer1000Minor: { 'api.calls': 50 },
};
export const F1000_BODY = {
  interval: 'MONTH',
  unitAmountMinor: 1000,
  perSeat: false,
};
export const F2000_BODY = {
  interval: 'MONTH',
  unitAmountMinor: 2000,
  perSeat: false,
};
