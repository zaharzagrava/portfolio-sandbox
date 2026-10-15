/**
 * SC-001 and SC-002 of S17: 10,000 due subscriptions are renewed by the billing run, with two runs at once, and
 * 0 are billed twice, 0 periods are skipped, and 99% are renewed within 15 minutes of their period end. Performance job
 * only (it writes 10,000 subscriptions); it is NOT part of the test suites and is listed in `specs/UNVERIFIED.md` as
 * `not run` until someone runs it against a seeded database with the real worker running.
 *
 *   DB_HOST=... DB_PORT=... DB_USERNAME=... DB_PASSWORD=... DB_NAME=... \
 *     pnpm tsx scripts/bench/billing-run-10k.ts [subscriptions=10000]
 *
 * It seeds `subscriptions` shop subscriptions whose period ended five minutes ago, enqueues two `billing.run` jobs at
 * the same instant (the worker's concurrency of 1 per type and the row locks make them take turns, which is what two
 * replicas do), waits until none is due, and prints the invariants as one JSON line. Crashes and duplicate charge
 * deliveries are not injected by the script: kill the worker while it runs (and start it again) to prove the "random
 * worker crashes" part of SC-001; the small-scale proofs are AS-28, AS-37 and AS-45.
 */
import { Client } from 'pg';

const COUNT = Number(process.argv[2] ?? 10_000);
const BUDGET_MS = 15 * 60_000;

async function main(): Promise<void> {
  const db = new Client();
  await db.connect();
  await db.query(
    `INSERT INTO "Subscription" ("subjectType", "subjectId", "priceId", "status", "quantity", "billingAnchorDay",
                                 "currentPeriodStart", "currentPeriodEnd", "version")
     SELECT 'SHOP', gen_random_uuid(), pr.id, 'ACTIVE', 1, 1,
            date_trunc('minute', now()) - interval '1 month' - interval '5 minutes',
            date_trunc('minute', now()) - interval '5 minutes', 0
       FROM generate_series(1, $1), (SELECT pr.id FROM "Price" pr JOIN "Plan" p ON p.id = pr."planId"
                                      WHERE p.code = 'starter' AND pr.active ORDER BY pr."version" LIMIT 1) pr`,
    [COUNT],
  );
  const started = Date.now();
  for (let i = 0; i < 2; i++)
    await db.query(
      `INSERT INTO "Job" ("type", "payload", "runAt", "maxAttempts") VALUES ('billing.run', '{}'::jsonb, now(), 1)`,
    );
  for (;;) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM "Subscription" WHERE "status" = 'ACTIVE' AND "version" = 0 AND "currentPeriodEnd" <= now()`,
    );
    if (rows[0].n === 0) break;
    if (Date.now() - started > BUDGET_MS * 3) throw new Error('the run did not finish in 3x the budget');
    // the run takes at most 500 a time every ten minutes by schedule; enqueue another while work remains
    await db.query(
      `INSERT INTO "Job" ("type", "payload", "runAt", "maxAttempts")
       SELECT 'billing.run', '{}'::jsonb, now(), 1
        WHERE NOT EXISTS (SELECT 1 FROM "Job" WHERE "type" = 'billing.run' AND "status" IN ('QUEUED', 'RUNNING'))`,
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const elapsed = Date.now() - started;
  const doubled = await db.query(
    `SELECT count(*)::int AS n FROM (SELECT "subscriptionId", "businessKey" FROM "Invoice" GROUP BY 1, 2 HAVING count(*) > 1) d`,
  );
  const skipped = await db.query(
    `SELECT count(*)::int AS n FROM "Subscription" s
      WHERE s."version" <> 1 AND s."currentPeriodStart" >= now() - interval '1 hour'`,
  );
  const within = await db.query(
    `SELECT count(*) FILTER (WHERE i."createdAt" - s."currentPeriodStart" <= interval '15 minutes')::float / NULLIF(count(*), 0) AS share
       FROM "Invoice" i JOIN "Subscription" s ON s.id = i."subscriptionId" WHERE i."businessKey" LIKE 'renewal:%' AND s."version" = 1`,
  );
  console.log(
    JSON.stringify({
      subscriptions: COUNT,
      elapsedSeconds: elapsed / 1000,
      billedTwice: doubled.rows[0].n,
      skippedOrOddVersion: skipped.rows[0].n,
      renewedWithin15Minutes: within.rows[0].share,
      ok: doubled.rows[0].n === 0 && skipped.rows[0].n === 0 && Number(within.rows[0].share) >= 0.99,
    }),
  );
  await db.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
