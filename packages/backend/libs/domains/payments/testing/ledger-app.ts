import type { Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
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
    env: { LEDGER_CURSOR_SECRET: KIT_LEDGER_CURSOR_SECRET, ...options.env },
  });
  const runner = base.app.get(TransactionRunner);
  return {
    ...base,
    ledger: base.app.get(LedgerService),
    sequelize: base.app.get(Sequelize),
    runner,
    inTx: (fn) => runner.run(fn),
  };
}
