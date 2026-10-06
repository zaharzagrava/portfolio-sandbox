// SD-29 - job throughput / horizontal scaling benchmark.
//
//   NODE_ENV=local pnpm start:dev:worker   (1, 2, then 4 instances - e.g. PORT=8501.. in separate shells)
//   JOBS=50000 node scripts/load-tests/jobs-drain.js
//
// Bulk-inserts JOBS `jobs.noop` jobs due now, then polls until all are
// SUCCEEDED and prints drain time + jobs/s. Run it at 1/2/4 worker
// instances: throughput should scale ~linearly until Postgres write IOPS
// (≈2 updates per job) becomes the bottleneck (D25 capacity model).
// Also verifies the at-least-once + idempotent contract: no job runs twice
// (attempts must all be 1 with no reaping during the run).
require('dotenv').config();
const { Client } = require('pg');

const JOBS = Number(process.env.JOBS || 50000);

async function main() {
  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await db.connect();

  console.log(`enqueueing ${JOBS} jobs.noop ...`);
  await db.query(
    `INSERT INTO "Job" (type, payload, "runAt") SELECT 'jobs.noop', '{}'::jsonb, now() FROM generate_series(1, $1)`,
    [JOBS],
  );

  const started = Date.now();
  for (;;) {
    const { rows } = await db.query(`SELECT count(*)::int AS left FROM "Job" WHERE type = 'jobs.noop' AND status <> 'SUCCEEDED'`);
    if (rows[0].left === 0) break;
    process.stdout.write(`\r${rows[0].left} remaining   `);
    await new Promise((r) => setTimeout(r, 500));
  }
  const seconds = (Date.now() - started) / 1000;

  const { rows: dupes } = await db.query(`SELECT count(*)::int AS n FROM "Job" WHERE type = 'jobs.noop' AND attempts > 1`);
  console.log(`\ndrained ${JOBS} jobs in ${seconds.toFixed(1)}s → ${(JOBS / seconds).toFixed(0)} jobs/s; re-executions: ${dupes[0].n}`);

  await db.query(`DELETE FROM "Job" WHERE type = 'jobs.noop'`);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
