/**
 * Benchmark and chaos run of the order export (S12 AS-12, SC-001, SC-003 100k part, SC-005). An ops artifact
 * (specs/UNVERIFIED.md): it prints the numbers and exits non-zero over 5 minutes or 200 MB of heap, it is not a jest
 * test and no build gate. Run it by hand against a throwaway database and a throwaway bucket of the test stack.
 *
 * It WRITES `--lines` order lines (default 1,000,000) into an isolated shop of the configured database, runs the real
 * run service (keyset reader → CSV → storage), samples `process.memoryUsage().heapUsed` once a second and prints time,
 * peak heap and the SHA-256 of the file. It removes its rows at the end (`--keep` keeps them).
 *
 *   pnpm exec ts-node -r tsconfig-paths/register scripts/bench/order-export-bench.ts --lines 100000 --verify
 *   pnpm exec ts-node -r tsconfig-paths/register scripts/bench/order-export-bench.ts --lines 100000 --chaos 5
 *
 * `--verify` runs the export twice and requires identical bytes. `--chaos <k>` interrupts the run at k random points
 * (a graceful release, as a deploy does) and requires the final file to equal the uninterrupted one (SC-005).
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { ObjectStorage } from '../../libs/infrastructure/storage/object-storage.port';
import { generateTestingModule } from '../../test/utils/global-modules';
import { OrderExportRunService } from '../../libs/domains/orders/application/order-export-run.service';
import {
  EXPORT_JOBS,
  type ExportJobsPort,
} from '../../libs/domains/orders/domain/export-ports';
import { OrderExportRunModule } from '../../libs/domains/orders/order-export-worker.module';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const LINES = Number(arg('lines') ?? 1_000_000);
const CHAOS = Number(arg('chaos') ?? 0);
const BUDGET_MS = 5 * 60_000;
const BUDGET_HEAP = 200 * 1024 * 1024;

async function main(): Promise<void> {
  const moduleRef = await generateTestingModule([OrderExportRunModule], {
    stores: ['redis', 'dynamo'],
  });
  await moduleRef.init();
  const db = moduleRef.get(Sequelize);
  const run = moduleRef.get(OrderExportRunService);
  const jobs = moduleRef.get<ExportJobsPort>(EXPORT_JOBS);
  const storage = moduleRef.get(ObjectStorage);

  const shopId = uuidv7();
  const productId = uuidv7();
  // `BisOrder.userId` references `User`: the orders belong to any existing user of the throwaway database.
  const [buyer] = await db.query<{ id: string }>(
    `SELECT "id" FROM "User" LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  if (!buyer) throw new Error('the database has no user to own the orders');
  const userId = buyer.id;
  const createdAt = new Date(Date.now() - 86_400_000);
  const perOrder = 10;
  console.log(`seeding ${LINES} lines for shop ${shopId} ...`);
  for (let done = 0; done < LINES;) {
    const chunk = Math.min(LINES - done, 100_000);
    await db.query(
      `WITH o AS (
         INSERT INTO "BisOrder" ("id", "userId", "status", "total", "currency", "idempotencyKey", "requestHash", "version", "createdAt", "updatedAt")
         SELECT uuidv7(), :userId, 'PAID', 0, 'EUR', 'bench-' || :shopId || '-' || gen_random_uuid()::text, 'bench', 1, :at, :at
           FROM generate_series(1, :orders) RETURNING "id"),
       so AS (
         INSERT INTO "ShopOrder" ("id", "bisOrderId", "shopId", "subtotal", "status", "createdAt", "updatedAt")
         SELECT uuidv7(), o."id", :shopId, 0, 'PAID', :at, :at FROM o RETURNING "bisOrderId")
       INSERT INTO "BisOrderItem" ("id", "bisOrderId", "productId", "title", "quantity", "priceAtPurchase", "discountMinor", "lineTotalMinor", "shopId", "createdAt", "updatedAt")
       SELECT uuidv7(), so."bisOrderId", :productId, 'Bench item', 1, 1000, 0, 1000, :shopId, :at, :at
         FROM so, generate_series(1, :perOrder)`,
      {
        replacements: {
          userId,
          shopId,
          productId,
          at: createdAt,
          orders: Math.ceil(chunk / perOrder),
          perOrder,
        },
      },
    );
    done += chunk;
  }

  // The application itself holds heap (every module of the testing app); the budget is for what the export adds.
  const baselineHeap = () => {
    global.gc?.();
    return process.memoryUsage().heapUsed;
  };
  let lastElapsedMs = 2_000;

  const exportOnce = async (interruptions: number) => {
    const baseline = baselineHeap();
    const created = await jobs.createWithActiveGuard({
      shopId,
      createdBy: userId,
      now: new Date(),
    });
    if (created.kind !== 'created')
      throw new Error('an export is already active');
    const exportId = created.job.id;
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 1_000);
    const started = performance.now();
    let outcome = 'shutdown';
    let cuts = 0;
    while (outcome === 'shutdown') {
      if (cuts < interruptions) {
        const delay = lastElapsedMs * (0.05 + Math.random() * 0.85);
        setTimeout(() => run.shutdown(), delay).unref();
        cuts += 1;
      }
      outcome = await run.handle(exportId);
    }
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    const elapsed = performance.now() - started;
    if (interruptions === 0) lastElapsedMs = elapsed;
    const job = await jobs.findById(exportId);
    if (outcome !== 'done' || !job?.fileKey)
      throw new Error(`the export ended as ${outcome}`);
    const hash = createHash('sha256');
    for await (const chunk of await storage.getStream(job.fileKey))
      hash.update(chunk as Buffer);
    return {
      exportId,
      elapsedMs: Math.round(elapsed),
      peakHeapGrowthMb: Math.round(Math.max(0, peak - baseline) / 1024 / 1024),
      interruptions: cuts,
      rows: job.rowsWritten,
      bytes: job.bytesWritten,
      sha256: hash.digest('hex'),
    };
  };

  let failed = false;
  try {
    const first = await exportOnce(0);
    console.log(JSON.stringify({ run: 'uninterrupted', ...first }));
    if (
      first.elapsedMs > BUDGET_MS ||
      first.peakHeapGrowthMb * 1024 * 1024 > BUDGET_HEAP
    ) {
      console.error(
        `over budget: ${first.elapsedMs} ms (limit ${BUDGET_MS}), +${first.peakHeapGrowthMb} MB heap (limit ${BUDGET_HEAP / 1024 / 1024})`,
      );
      failed = true;
    }
    if (flag('verify')) {
      const second = await exportOnce(0);
      console.log(JSON.stringify({ run: 'second', ...second }));
      if (second.sha256 !== first.sha256) {
        console.error('the two files differ');
        failed = true;
      }
    }
    if (CHAOS > 0) {
      const chaos = await exportOnce(CHAOS);
      console.log(JSON.stringify({ run: `chaos(${CHAOS})`, ...chaos }));
      if (chaos.sha256 !== first.sha256) {
        console.error(
          'the file after interruptions differs from the uninterrupted one',
        );
        failed = true;
      }
    }
  } finally {
    if (!flag('keep')) {
      await db.query(`DELETE FROM "BisOrderItem" WHERE "shopId" = :shopId`, {
        replacements: { shopId },
      });
      await db.query(`DELETE FROM "ShopOrder" WHERE "shopId" = :shopId`, {
        replacements: { shopId },
      });
      await db.query(
        `DELETE FROM "BisOrder" WHERE "idempotencyKey" LIKE :prefix`,
        {
          replacements: { prefix: `bench-${shopId}-%` },
        },
      );
      await db.query(
        `DELETE FROM "ExportJobHistory" WHERE "shopId" = :shopId`,
        { replacements: { shopId } },
      );
      await db.query(`DELETE FROM "ExportJob" WHERE "shopId" = :shopId`, {
        replacements: { shopId },
      });
    }
    await moduleRef.close();
  }
  if (failed) process.exitCode = 1;
}

main()
  // Redis and storage clients keep the loop alive after `close()`; the result is already printed.
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
