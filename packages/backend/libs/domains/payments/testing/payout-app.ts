import type { Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import { LedgerService } from '../application/ledger.service';
import { PayoutAuditService } from '../application/payout-audit.service';
import { PayoutCancelService } from '../application/payout-cancel.service';
import { PayoutCreationService } from '../application/payout-creation.service';
import { PayoutResolverService } from '../application/payout-resolver.service';
import { PayoutRunService } from '../application/payout-run.service';
import { PayoutTransferService } from '../application/payout-transfer.service';
import { PAYOUT_PROVIDER, SHOP_SUMMARY_PORT } from '../domain/payout-ports';
import { PayoutJobs } from '../infra/payout.jobs';
import { PayoutsModule } from '../payouts.module';
import { PayoutsWorkerModule } from '../payouts-worker.module';
import { KIT_LEDGER_CURSOR_SECRET } from './ledger-app';
import { FakePayoutProvider } from './fake-payout-provider';
import { FakeShopSummary } from './fake-shop-summary';

export interface PayoutTestApp extends CatalogTestApp {
  sequelize: Sequelize;
  runner: TransactionRunner;
  ledger: LedgerService;
  provider: FakePayoutProvider;
  shops: FakeShopSummary;
  jobs: PayoutJobs;
  run: PayoutRunService;
  creation: PayoutCreationService;
  transfers: PayoutTransferService;
  resolver: PayoutResolverService;
  cancellation: PayoutCancelService;
  audit: PayoutAuditService;
  inTx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

/**
 * The real app the payout specs run against: `PayoutsModule` and `PayoutsWorkerModule` (so the controllers and the job
 * handlers) next to the identity API and the catalog's tenancy, over real Postgres, Redis, DynamoDB Local and the
 * outbox, with the production prefix, pipe and filter. Faked only at the edges: the payment provider, tenancy's R1
 * answer for the payout gates, and the clock (S15 test-plan.md).
 */
export async function createPayoutApp(
  options: { env?: Record<string, string>; redisUrl?: string } = {},
): Promise<PayoutTestApp> {
  const provider = new FakePayoutProvider();
  const shops = new FakeShopSummary();
  const base = await createCatalogApp({
    redisUrl: options.redisUrl,
    extraImports: [PayoutsModule, PayoutsWorkerModule],
    overrides: [
      { provide: PAYOUT_PROVIDER, useValue: provider },
      { provide: SHOP_SUMMARY_PORT, useValue: shops },
    ],
    env: {
      LEDGER_CURSOR_SECRET: KIT_LEDGER_CURSOR_SECRET,
      PLATFORM_CURRENCY: 'EUR',
      ...options.env,
    },
  });
  const get = <T>(token: new (...args: never[]) => T): T =>
    base.app.get(token, { strict: false });
  const runner = get(TransactionRunner);
  const reset = base.reset.bind(base);
  return {
    ...base,
    async reset() {
      await reset();
      provider.reset();
      shops.reset();
    },
    sequelize: base.app.get(Sequelize),
    runner,
    ledger: get(LedgerService),
    provider,
    shops,
    jobs: get(PayoutJobs),
    run: get(PayoutRunService),
    creation: get(PayoutCreationService),
    transfers: get(PayoutTransferService),
    resolver: get(PayoutResolverService),
    cancellation: get(PayoutCancelService),
    audit: get(PayoutAuditService),
    inTx: (fn) => runner.run(fn),
  };
}
