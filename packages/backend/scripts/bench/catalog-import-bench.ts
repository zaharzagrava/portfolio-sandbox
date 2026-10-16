/**
 * Benchmark of the bulk import (S07 SC-001, SC-002, SC-006). An ops artifact (specs/UNVERIFIED.md): it prints the numbers
 * and exits non-zero over 15 minutes or 200 MB of RSS per run; it is not a jest test and no build gate. Run it by hand
 * against a throwaway database and a throwaway bucket of the test stack (MinIO, Postgres, Redis); the malware scanner is
 * switched off for the run (the benchmark measures the pipeline, not clamd).
 *
 * It WRITES a generated catalog file per shop into object storage and the products into the catalog, runs the real
 * `ImportRunnerService` (storage stream, parser, 500-row batches through the catalog's import command, fenced
 * checkpoints), samples the process RSS once a second and prints per-shop start/finish times and the gaps between
 * progress events.
 *
 *   pnpm exec ts-node -r tsconfig-paths/register scripts/bench/catalog-import-bench.ts --rows 1000000
 *   pnpm exec ts-node -r tsconfig-paths/register scripts/bench/catalog-import-bench.ts --rows 1000000 --shops 20
 *
 * `--rows` is the rows per file (default 1,000,000, about 5 GiB-class at 5 KB a row with a long description: raise the
 * description repeat in `catalog-import-support.ts` to reach the exact size). `--shops` runs that many imports at once,
 * one shop each (SC-002).
 */
import { performance } from 'node:perf_hooks';
import {
  arg,
  boot,
  mib,
  sampleRss,
  uploadedImport,
} from './catalog-import-support';

const ROWS = Number(arg('rows') ?? 1_000_000);
const SHOPS = Number(arg('shops') ?? 1);
const BUDGET_MS = 15 * 60_000;
const BUDGET_RSS = 200 * 1024 * 1024;

async function main(): Promise<void> {
  const b = await boot();
  console.log(`preparing ${SHOPS} shop(s) with ${ROWS} rows each ...`);
  const jobs: Array<{ shopId: string; importId: string }> = [];
  for (let i = 0; i < SHOPS; i++) {
    const seller = await b.shop();
    jobs.push({
      shopId: seller.shopId,
      importId: await uploadedImport(b, seller, ROWS, `B${i}`),
    });
  }

  const rss = sampleRss();
  const began = performance.now();
  const results = await Promise.all(
    jobs.map(async (job) => {
      const runner = b.newRunner();
      const started = performance.now();
      const outcome = await runner.handle(job.importId, 1);
      return {
        ...job,
        outcome,
        startedMs: started - began,
        finishedMs: performance.now() - began,
      };
    }),
  );
  const peak = rss.stop();
  const total = performance.now() - began;

  let failed = false;
  for (const r of results) {
    const row = await b.repo.findById(r.importId);
    const events = b.events.filter(
      (e) => e.topic === `import:${r.importId}` && e.type === 'progress',
    );
    let widest = 0;
    for (let i = 1; i < events.length; i++)
      widest = Math.max(widest, events[i].at - events[i - 1].at);
    console.log(
      `shop ${r.shopId}: ${r.outcome} status=${row?.status} rows=${row?.rowsProcessed} failed=${row?.rowsFailed} ` +
        `start=${Math.round(r.startedMs)}ms finish=${Math.round(r.finishedMs)}ms ` +
        `rows/s=${Math.round(((row?.rowsProcessed ?? 0) / (r.finishedMs - r.startedMs)) * 1000)} ` +
        `progress events=${events.length} widest gap=${widest}ms`,
    );
    if (row?.status !== 'DONE' || r.finishedMs > BUDGET_MS) failed = true;
  }
  console.log(
    `total ${Math.round(total / 1000)} s, peak RSS ${mib(peak)} MiB (budgets: ${BUDGET_MS / 60_000} min, ${mib(BUDGET_RSS)} MiB)`,
  );
  if (peak > BUDGET_RSS) failed = true;
  console.log(failed ? 'BUDGET MISSED' : 'within budget');
  await b.app.close();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
