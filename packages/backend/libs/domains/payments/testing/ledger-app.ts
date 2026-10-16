import type { Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import {
  resetCommissionRates,
  setCommissionBelief,
} from '@app/test/fixtures/commission-rates';
import { LedgerService } from '../application/ledger.service';
import { LedgerModule } from '../ledger.module';

/** The secret the ledger kit boots the app with (`LEDGER_CURSOR_SECRET`, at least 32 bytes). */
export const KIT_LEDGER_CURSOR_SECRET =
  'ledger-kit-cursor-secret-0123456789abcdef-xyz';

export interface LedgerTestApp extends CatalogTestApp {
  ledger: LedgerService;
  sequelize: Sequelize;
  runner: TransactionRunner;
  /** Runs `fn` in a transaction the way a caller does (commit on return, rollback on throw). */
  inTx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Records a commission belief for a shop (and category) valid from `validFrom`, known at every instant of the fake clock. */
  setCommission(rate: {
    shopId: string;
    category?: string;
    rateBps: number;
    validFrom: Date;
  }): Promise<void>;
}

/**
 * The real app the ledger specs run against: `LedgerModule` (and whatever `extraImports` adds) next to the identity
 * API, over real Postgres, Redis, DynamoDB Local and the outbox, with the production prefix, pipe and filter. Only
 * the clock (and what a spec overrides) is faked: the posting, the store's commit-time check, locks and the outbox
 * run for real (S14 test-plan.md).
 */
export async function createLedgerApp(
  options: {
    extraImports?: unknown[];
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
    env?: Record<string, string>;
    redisUrl?: string;
  } = {},
): Promise<LedgerTestApp> {
  const base = await createCatalogApp({
    redisUrl: options.redisUrl,
    extraImports: [LedgerModule, ...(options.extraImports ?? [])],
    overrides: options.overrides,
    env: {
      LEDGER_CURSOR_SECRET: KIT_LEDGER_CURSOR_SECRET,
      PLATFORM_CURRENCY: 'EUR',
      ...options.env,
    },
  });
  const runner = base.app.get(TransactionRunner);
  const sequelize = base.app.get(Sequelize);
  const reset = base.reset.bind(base);
  return {
    ...base,
    ledger: base.app.get(LedgerService),
    sequelize,
    runner,
    inTx: (fn) => runner.run(fn),
    async reset() {
      await reset();
      await resetCommissionRates(sequelize); // the settlement prices with the default 10 % (S16)
    },
    setCommission: (rate) => setCommissionBelief(sequelize, rate),
  };
}
