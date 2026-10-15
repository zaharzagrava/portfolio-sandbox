import { v4 as uuidv4 } from 'uuid';
import type { Statement } from '@marketplace-sandbox/contracts';
import { ds1Messages } from '@app/test/fixtures/statements';
import type { StatementsTestApp } from './statements-app';

/**
 * Flows the statements specs share, built only from the public routes and the real consumers (S16 test-plan.md).
 * A session lives five minutes of the fake clock, so every flow that follows a clock move signs in again.
 */
export interface Shops {
  a: string;
  b: string;
  c: string;
}

export async function createShops(t: StatementsTestApp): Promise<Shops> {
  return {
    a: (await t.shopWithOwner()).shopId,
    b: (await t.shopWithOwner()).shopId,
    c: (await t.shopWithOwner()).shopId,
  };
}

export const seedDs1 = (t: StatementsTestApp, shops: Shops) =>
  t.sales.deliver(...ds1Messages(shops));

export const setClock = (t: StatementsTestApp, iso: string) =>
  t.clock.set(new Date(iso));

/** The operator closes a month and the queued work runs: the month is `CLOSED` (and its follow-ups done) afterwards. */
export async function closeMonth(
  t: StatementsTestApp,
  month: string,
  atIso?: string,
): Promise<{ runId: string }> {
  if (atIso) setClock(t, atIso);
  const admin = await t.admin();
  const res = await t
    .as(admin)
    .post(`/api/admin/accounting-periods/${month}/close`)
    .set('Idempotency-Key', uuidv4());
  if (res.status !== 202)
    throw new Error(`close ${month} answered ${res.status}: ${JSON.stringify(res.body)}`);
  await t.drainJobs();
  return { runId: res.body.runId };
}

export async function setRate(
  t: StatementsTestApp,
  body: Record<string, unknown>,
  atIso?: string,
) {
  if (atIso) setClock(t, atIso);
  const admin = await t.admin();
  const res = await t
    .as(admin)
    .post('/api/admin/commission-rates')
    .set('Idempotency-Key', uuidv4())
    .send(body);
  if (res.status !== 201 && res.status !== 200)
    throw new Error(`rate answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as {
    changeId: string;
    changed: boolean;
    affectedClosedMonths: string[];
  };
}

/** RC1 of the spec: shop `a`, electronics, 700 bps from 2026-03-01, reason `promo-2026-03`. */
export const rc1 = (shopId: string, extra: Record<string, unknown> = {}) => ({
  shopId,
  category: 'electronics',
  rateBps: 700,
  validFrom: '2026-03-01T00:00:00Z',
  reason: 'promo-2026-03',
  ...extra,
});

/** A statement read the way a seller makes it (a fresh owner session). */
export async function readStatement(
  t: StatementsTestApp,
  shopId: string,
  month: string,
  query = '',
): Promise<Statement> {
  const owner = await t.member(shopId, 'OWNER');
  const res = await t.as(owner).get(`/api/shops/${shopId}/statements/${month}${query}`);
  if (res.status !== 200)
    throw new Error(`statement ${month} answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as Statement;
}

export const adjustmentsOf = (t: StatementsTestApp, shopId?: string) =>
  t.sql<{
    id: string;
    shopId: string;
    refersToMonth: string;
    bookedMonth: string;
    causeKind: string;
    causeRef: string;
    gross: string;
    commission: string;
    lines: number;
    payouts: string;
    reason: string;
  }>(
    `SELECT id, "shopId", to_char("refersToMonth", 'YYYY-MM') AS "refersToMonth", to_char("bookedMonth", 'YYYY-MM') AS "bookedMonth",
            "causeKind", "causeRef", "grossDeltaMinor"::text AS gross, "commissionDeltaMinor"::text AS commission,
            "lineCountDelta" AS lines, "payoutsPaidDeltaMinor"::text AS payouts, reason
       FROM "StatementAdjustment" WHERE (CAST(:shop AS uuid) IS NULL OR "shopId" = CAST(:shop AS uuid)) ORDER BY "createdAt", id`,
    { shop: shopId ?? null },
  );
