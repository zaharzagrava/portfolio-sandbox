/**
 * SC-004 of S16: closing a month for 100,000 shops with sales takes under 5 minutes, in batches of at most 10,000.
 * Performance job only (it writes 100,000 shops of facts); it is NOT part of the test suites and is listed in
 * `specs/UNVERIFIED.md` as `not run` until someone runs it against a seeded database.
 *
 *   DB_HOST=... DB_PORT=... DB_USERNAME=... DB_PASSWORD=... DB_NAME=... \
 *     pnpm tsx scripts/bench/statements-close-100k.ts [shops=100000] [month=2026-03]
 *
 * It seeds `StatementSaleFact` for `shops` synthetic shops (one line each, priced by the default rate), requests the
 * close over HTTP with an admin bearer token (`ADMIN_BEARER`, `API_URL`) and polls `GET /admin/accounting-periods/:month`
 * until `CLOSED`. The month must already have ended and the three stream watermarks must have passed its end.
 * The result line carries the elapsed seconds and the verdict against the 300 s budget.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const SHOPS = Number(process.argv[2] ?? 100_000);
const MONTH = process.argv[3] ?? '2026-03';
const API_URL = process.env.API_URL ?? 'http://localhost:8010/api';
const BEARER = process.env.ADMIN_BEARER ?? '';
const BUDGET_S = 300;

async function seed(db: Client): Promise<void> {
  const paidAt = `${MONTH}-15T12:00:00Z`;
  await db.query(
    `INSERT INTO "StatementSaleFact"
       ("orderId", "lineId", "orderVersion", "shopId", "productId", "category", "quantity", "unitPriceMinor", "discountMinor",
        "lineTotalMinor", "paidAt", "recordedAt", "appliedAt", "eventId")
     SELECT gen_random_uuid(), gen_random_uuid()::text, 1, gen_random_uuid(), gen_random_uuid()::text, 'electronics', 1, 1000, 0,
            1000, $1::timestamptz, $1::timestamptz, $1::timestamptz, gen_random_uuid()
       FROM generate_series(1, $2)`,
    [paidAt, SHOPS],
  );
}

async function main(): Promise<void> {
  if (!BEARER) throw new Error('ADMIN_BEARER is required (an admin access token)');
  const db = new Client();
  await db.connect();
  await seed(db);
  const headers = { Authorization: BEARER, 'Idempotency-Key': randomUUID() };
  const started = Date.now();
  const res = await fetch(`${API_URL}/admin/accounting-periods/${MONTH}/close`, { method: 'POST', headers });
  if (res.status !== 202) throw new Error(`close answered ${res.status}: ${await res.text()}`);
  for (;;) {
    const status = (await (await fetch(`${API_URL}/admin/accounting-periods/${MONTH}`, { headers: { Authorization: BEARER } })).json()) as {
      status: string;
    };
    if (status.status === 'CLOSED') break;
    if ((Date.now() - started) / 1000 > BUDGET_S * 3) throw new Error('close did not finish in 3x the budget');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const elapsed = (Date.now() - started) / 1000;
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM "StatementSnapshot" WHERE month = $1::date`, [`${MONTH}-01`]);
  console.log(
    JSON.stringify({ shops: SHOPS, snapshots: rows[0].n, elapsedSeconds: elapsed, budgetSeconds: BUDGET_S, ok: elapsed < BUDGET_S }),
  );
  await db.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
