/**
 * Builds the S18 settlement ledger rows for the renewal invoices of the last 90 days that the previous implementation
 * issued (S18 FR-032). Repeatable: a second run inserts nothing. It needs the usage store, which is why it is a script
 * and not part of the SQL migration `20261016000500-billing-s18-usage-settlement.js`; when the usage store is
 * unreachable it fails and can simply be run again.
 *
 *   pnpm billing:backfill-usage-settlement
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { BillingCoreModule } from '@app/domains/billing/billing-core.module';
import { UsageSettlementBackfill } from '@app/domains/billing/infra/usage-settlement.backfill';
import { DatabaseModule } from '@app/infrastructure/database';

@Module({ imports: [ApiConfigModule, DatabaseModule, BillingCoreModule] })
class BackfillModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(BackfillModule, {
    logger: ['error', 'warn'],
  });
  try {
    const result = await app
      .get(UsageSettlementBackfill, { strict: false })
      .run(new Date());
    console.log(
      `usage settlement backfill: ${result.examined} invoice(s) examined, ${result.inserted} ledger row(s) inserted, ${result.mismatches} mismatch(es)`,
    );
  } finally {
    await app.close();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
