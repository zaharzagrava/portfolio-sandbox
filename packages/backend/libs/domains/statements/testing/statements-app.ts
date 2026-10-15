import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize';
import { Role } from '@app/domains/identity';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsWorkerModule } from '@app/infrastructure/jobs/jobs-worker.module';
import { JobWorker } from '@app/infrastructure/jobs/job-worker.service';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { createDelivery } from '@app/test/fixtures/statements';
import {
  FACT_STREAMS,
  STREAM_LAG,
  type FactStream,
  type StreamLag,
} from '../domain/ports';
import {
  LedgerFactProjector,
  PayoutFactProjector,
  SalesFactProjector,
} from '../infra/fact-projectors';
import { StatementsModule } from '../statements.module';
import { StatementsProjectorModule } from '../statements-projector.module';
import { StatementsWorkerModule } from '../statements-worker.module';

const DEFAULT_RATE_SEED = `
  INSERT INTO "CommissionRate" ("shopKey", category, "rateBps", "validPeriod", "recordedPeriod", reason)
  VALUES ('00000000-0000-0000-0000-000000000000', '*', 1000, tstzrange('-infinity', NULL), tstzrange('-infinity', NULL), 'initial default')`;

/** The broker's consumer lag is an edge: the spec says per stream whether the group has read everything. */
export class FakeStreamLag implements StreamLag {
  private readonly caught = new Map<FactStream, boolean>();
  constructor() {
    this.reset();
  }
  reset(): void {
    for (const stream of FACT_STREAMS) this.caught.set(stream, true);
  }
  set(stream: FactStream, caughtUp: boolean): void {
    this.caught.set(stream, caughtUp);
  }
  isCaughtUp(stream: FactStream): Promise<boolean> {
    return Promise.resolve(this.caught.get(stream) ?? false);
  }
}

export interface StatementsTestApp extends CatalogTestApp {
  sequelize: Sequelize;
  runner: TransactionRunner;
  worker: JobWorker;
  lag: FakeStreamLag;
  sales: ReturnType<typeof createDelivery>;
  payouts: ReturnType<typeof createDelivery>;
  ledger: ReturnType<typeof createDelivery>;
  /** Test code may touch every table (IX.6): reads and privileged setup only, never the domain's own writes. */
  sql<T = Record<string, unknown>>(
    text: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  admin(): Promise<TestUser>;
  /** A shop whose owner is `owner` (created when not given). */
  shopWithOwner(owner?: TestUser): Promise<{ shopId: string; owner: TestUser }>;
  member(
    shopId: string,
    role: 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER',
  ): Promise<TestUser>;
  /** Captured stdout of the structured logger (only with `structuredLogger: true`). */
  rawLogs(): string;
  /** Runs the queued jobs through the real worker (the S49 handler registration) until none is due. */
  drainJobs(): Promise<number>;
}

/**
 * The real app the statements specs run against: the three statements modules and the job worker (loops off, driven by
 * `drainJobs`) next to the identity API and the catalog's tenancy, over real Postgres, Redis, DynamoDB Local and the
 * outbox, with the production prefix, pipe and filter. Faked only at the edges: the clock and the broker's consumer
 * lag (S16 test-plan.md); facts arrive through the real consumers, delivered by the in-memory harness.
 */
export async function createStatementsApp(
  options: {
    env?: Record<string, string>;
    redisUrl?: string;
    structuredLogger?: boolean;
  } = {},
): Promise<StatementsTestApp> {
  const lag = new FakeStreamLag();
  const logChunks: string[] = [];
  const stdoutSpy = options.structuredLogger
    ? jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          logChunks.push(String(chunk));
          return true;
        })
    : null;
  const base = await createCatalogApp({
    structuredLogger: options.structuredLogger,
    redisUrl: options.redisUrl,
    extraImports: [
      StatementsModule,
      StatementsWorkerModule,
      StatementsProjectorModule,
      JobsWorkerModule.register({ loops: false }),
    ],
    overrides: [{ provide: STREAM_LAG, useValue: lag }],
    env: options.env,
  });
  const app: INestApplication = base.app;
  const sequelize = app.get<Sequelize>(getConnectionToken());
  const sql = <T>(text: string, replacements: Record<string, unknown> = {}) =>
    sequelize.query(text, {
      type: QueryTypes.SELECT,
      replacements,
    }) as Promise<T[]>;
  const reset = base.reset.bind(base);
  const worker = app.get(JobWorker, { strict: false });

  const self: StatementsTestApp = {
    ...base,
    sequelize,
    runner: app.get(TransactionRunner, { strict: false }),
    worker,
    lag,
    sales: createDelivery(app, SalesFactProjector),
    payouts: createDelivery(app, PayoutFactProjector),
    ledger: createDelivery(app, LedgerFactProjector),
    sql,
    rawLogs: () => logChunks.join(''),
    async close() {
      stdoutSpy?.mockRestore();
      await base.close();
    },
    async reset() {
      await reset();
      lag.reset();
      // `CommissionRate` survives `seeds.clean()`: put it back to the single default belief.
      await sequelize.query(`DELETE FROM "CommissionRate"`);
      await sequelize.query(DEFAULT_RATE_SEED);
    },
    admin: () => base.newUser({ role: Role.ADMIN }),
    async shopWithOwner(owner) {
      const user = owner ?? (await base.newUser());
      const shop = await createShop(app, user);
      return { shopId: shop.id, owner: user };
    },
    async member(shopId, role) {
      const user = await base.newUser();
      await addMember(app, shopId, user.id, role);
      return user;
    },
    async drainJobs() {
      let total = 0;
      for (let i = 0; i < 50; i++) {
        const ran = await worker.runOnce();
        if (ran === 0) break;
        total += ran;
      }
      return total;
    },
  };
  return self;
}
