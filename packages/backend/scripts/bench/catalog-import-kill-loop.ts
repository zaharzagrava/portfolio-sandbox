/**
 * Kill loop of the bulk import (S07 SC-003). An ops artifact (specs/UNVERIFIED.md): not a jest test and no build gate.
 * Run it by hand against a throwaway database and bucket of the test stack.
 *
 * It imports a generated file of `--rows` (default 100,000) rows twice into two shops: once uninterrupted, once with the
 * worker stopped (a graceful `shutdown()`, as a deploy does) at `--kills` (default 50) random points, a fresh runner
 * taking the message after each stop. It then compares the final status, the counters (they may differ by one batch
 * between created and unchanged) and a hash of every product of the two shops.
 *
 *   pnpm exec ts-node -r tsconfig-paths/register scripts/bench/catalog-import-kill-loop.ts --rows 100000 --kills 50
 */
import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import {
  arg,
  boot,
  uploadedImport,
  type Booted,
} from './catalog-import-support';

const ROWS = Number(arg('rows') ?? 100_000);
const KILLS = Number(arg('kills') ?? 50);

async function productHash(b: Booted, shopId: string): Promise<string> {
  const rows = await b.db.query<Record<string, unknown>>(
    `SELECT "externalSku", "title", "priceMinor", "quantity" FROM "Product" WHERE "shopId" = :shopId ORDER BY "externalSku"`,
    { replacements: { shopId }, type: QueryTypes.SELECT },
  );
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(row));
  return `${rows.length}:${hash.digest('hex')}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const b = await boot();

  const clean = await b.shop();
  const cleanId = await uploadedImport(b, clean, ROWS, 'K');
  await b.newRunner().handle(cleanId, 1);
  const expected = await b.repo.findById(cleanId);

  const chaos = await b.shop();
  const chaosId = await uploadedImport(b, chaos, ROWS, 'K');
  let kills = 0;
  let deliveries = 0;
  for (;;) {
    const runner = b.newRunner();
    deliveries++;
    const run = runner.handle(chaosId, Math.min(deliveries, 2)).then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error }),
    );
    if (kills < KILLS) {
      await Promise.race([sleep(200 + Math.random() * 3000), run]);
      kills++;
      await runner.shutdown();
    }
    const result = await run;
    const row = await b.repo.findById(chaosId);
    if (row && ['DONE', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(row.status))
      break;
    if ('error' in result && kills >= KILLS && deliveries > KILLS + 5)
      throw result.error;
  }

  const actual = await b.repo.findById(chaosId);
  const [expectedHash, actualHash] = [
    await productHash(b, clean.shopId),
    await productHash(b, chaos.shopId),
  ];
  const same = {
    status: actual?.status === 'DONE' && expected?.status === 'DONE',
    processed: actual?.rowsProcessed === expected?.rowsProcessed,
    failed: actual?.rowsFailed === expected?.rowsFailed,
    // a batch redone after a kill moves its rows from created to unchanged: the sum of both is exact
    changed:
      (actual?.rowsCreated ?? 0) + (actual?.rowsUnchanged ?? 0) ===
      (expected?.rowsCreated ?? 0) + (expected?.rowsUnchanged ?? 0),
    products: expectedHash === actualHash,
  };
  console.log(`kills=${kills} deliveries=${deliveries}`);
  console.log(
    'uninterrupted:',
    expected?.status,
    expected?.rowsProcessed,
    expected?.rowsCreated,
    expected?.rowsUnchanged,
  );
  console.log(
    'interrupted:  ',
    actual?.status,
    actual?.rowsProcessed,
    actual?.rowsCreated,
    actual?.rowsUnchanged,
  );
  console.log(same);
  const ok = Object.values(same).every(Boolean);
  console.log(ok ? 'IDENTICAL' : 'DIFFERENT');
  await b.app.close();
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
