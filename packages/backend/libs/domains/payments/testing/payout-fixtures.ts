import { v4 as uuidv4 } from 'uuid';
import type { ShopSummary } from '../domain/payout-ports';
import { assertBooksHealthy, balanceOf, sql } from './ledger-fixtures';
import type { PayoutTestApp } from './payout-app';

/** A Monday 06:00 `Europe/Warsaw` (CEST): the instant the weekly run is due, and its period. */
export const RUN_AT = new Date('2026-10-05T04:00:00.000Z');
export const PERIOD = '2026-10-05';

/** Funds a seller account by a real journal (never by inserting entries): the balance the run will see. */
export async function fund(
  t: PayoutTestApp,
  shopId: string,
  amountMinor: number,
): Promise<void> {
  await t.inTx((tx) =>
    t.ledger.postJournal(
      {
        kind: 'ADJUSTMENT',
        reference: `fund-${uuidv4()}`,
        currency: 'EUR',
        lines: [
          { accountId: 'PAYOUTS_SENT', amountMinor: -amountMinor },
          { accountId: `SHOP_${shopId}`, amountMinor },
        ],
      },
      tx,
    ),
  );
}

/** A destination row written directly (test code may touch every table, IX.6); `effectiveFrom` defaults to "already counts". */
export async function seedDestination(
  t: PayoutTestApp,
  shopId: string,
  accountId = `acct_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
  effectiveFrom: Date = new Date(RUN_AT.getTime() - 86_400_000),
): Promise<string> {
  await sql(
    t.app,
    `INSERT INTO "PayoutDestination" ("shopId", "providerAccountId", "effectiveFrom", "changedAt", "changedBy")
     VALUES (:shopId, :accountId, :effectiveFrom, :effectiveFrom, 'test')
     ON CONFLICT ("shopId") DO UPDATE SET "providerAccountId" = :accountId, "effectiveFrom" = :effectiveFrom`,
    { shopId, accountId, effectiveFrom },
  ).catch(ignoreNoRows);
  return accountId;
}

export async function seedReserve(
  t: PayoutTestApp,
  shopId: string,
  reserveBps: number,
): Promise<void> {
  await sql(
    t.app,
    `INSERT INTO "PayoutReserve" ("shopId", "reserveBps", "reason", "updatedBy", "updatedAt")
     VALUES (:shopId, :reserveBps, 'test', 'test', now())
     ON CONFLICT ("shopId") DO UPDATE SET "reserveBps" = :reserveBps`,
    { shopId, reserveBps },
  ).catch(ignoreNoRows);
}

function ignoreNoRows(error: unknown): void {
  // a SELECT-typed query over an INSERT returns no rows: not an error
  if (!/Cannot read|undefined/.test(String(error))) throw error;
}

/**
 * A seller as the run sees them: a fresh shop id known to tenancy (the fake), funded, with a destination that
 * already counts. Every part can be changed or left out (`destination: null`, `summary: null` = unknown shop).
 */
export async function seller(
  t: PayoutTestApp,
  options: {
    balance?: number;
    reserveBps?: number;
    destination?: string | null;
    effectiveFrom?: Date;
    summary?: Partial<ShopSummary> | null;
    shopId?: string;
  } = {},
): Promise<{ shopId: string; accountId: string | null }> {
  const shopId = options.shopId ?? uuidv4();
  if (options.summary !== null) t.shops.set(shopId, options.summary);
  if (options.balance) await fund(t, shopId, options.balance);
  if (options.reserveBps !== undefined)
    await seedReserve(t, shopId, options.reserveBps);
  let accountId: string | null = null;
  if (options.destination !== null)
    accountId = await seedDestination(
      t,
      shopId,
      options.destination,
      options.effectiveFrom,
    );
  return { shopId, accountId };
}

export interface PayoutRow {
  id: string;
  shopId: string;
  periodStart: string;
  status: string;
  amountMinor: string;
  reserveHeldMinor: string;
  destinationSnapshot: string | null;
  transferRef: string | null;
  failureCode: string | null;
  failureReason: string | null;
  attempts: number;
  payoutVersion: number;
}

export const payoutRows = (
  t: PayoutTestApp,
  where = 'TRUE',
  replacements: Record<string, unknown> = {},
): Promise<PayoutRow[]> =>
  sql<PayoutRow>(
    t.app,
    `SELECT "id", "shopId", "periodStart"::text AS "periodStart", "status", "amountMinor"::text AS "amountMinor",
            "reserveHeldMinor"::text AS "reserveHeldMinor", "destinationSnapshot", "transferRef", "failureCode",
            "failureReason", "attempts", "payoutVersion"
       FROM "Payout" WHERE ${where} ORDER BY "createdAt", "id"`,
    replacements,
  );

export const payoutOf = async (
  t: PayoutTestApp,
  shopId: string,
  periodStart = PERIOD,
): Promise<PayoutRow> => {
  const rows = await payoutRows(
    t,
    `"shopId" = :shopId AND "periodStart" = :periodStart`,
    { shopId, periodStart },
  );
  if (rows.length !== 1)
    throw new Error(`expected one payout for ${shopId}, found ${rows.length}`);
  return rows[0];
};

export const shopBalance = (t: PayoutTestApp, shopId: string) =>
  balanceOf(t.app, `SHOP_${shopId}`);

/** The rows a spec counts to prove "once": journals by kind, outbox events by type, send jobs, history rows. */
export async function tally(t: PayoutTestApp) {
  const one = async (query: string, replacements = {}) =>
    Number((await sql<{ n: string }>(t.app, query, replacements))[0]?.n ?? 0);
  const events = await sql<{ type: string; n: string }>(
    t.app,
    `SELECT "type", count(*)::text AS n FROM "Outbox" WHERE "type" LIKE 'payout.%' GROUP BY 1`,
  );
  return {
    payouts: await one(`SELECT count(*)::text AS n FROM "Payout"`),
    journals: await one(
      `SELECT count(*)::text AS n FROM "LedgerJournal" WHERE "kind" IN ('PAYOUT','PAYOUT_REVERSAL')`,
    ),
    sendJobs: await one(
      `SELECT count(*)::text AS n FROM "Job" WHERE "type" = 'payouts.send'`,
    ),
    history: await one(`SELECT count(*)::text AS n FROM "PayoutHistory"`),
    events: Object.fromEntries(events.map((e) => [e.type, Number(e.n)])),
  };
}

/**
 * The invariants every money scenario ends with (SC-003): every journal sums to zero, and `PAYOUT_CLEARING` holds
 * exactly the payouts that are neither paid, failed nor cancelled.
 */
export async function assertPayoutBooks(t: PayoutTestApp): Promise<void> {
  await assertBooksHealthy(t.app);
  const inFlight = await sql<{ total: string }>(
    t.app,
    `SELECT coalesce(sum("amountMinor"), 0)::text AS total FROM "Payout" WHERE "status" IN ('PENDING','SENDING','UNKNOWN')`,
  );
  expect(await balanceOf(t.app, 'PAYOUT_CLEARING')).toBe(
    Number(inFlight[0].total),
  );
}
