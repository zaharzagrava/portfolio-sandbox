import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { Role } from '@app/domains/identity';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { JobsWorkerModule } from '@app/infrastructure/jobs/jobs-worker.module';
import { JobWorker } from '@app/infrastructure/jobs/job-worker.service';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { FakeBillingProvider } from '@app/test/fakes/billing-provider.fake';
import { FakeUsageLines } from '@app/test/fakes/billing-usage.fake';
import { DS1_SEED_SQL, createDelivery } from '@app/test/fixtures/billing';
import { BILLING_PROVIDER_TRANSPORT } from '../infra/stripe-billing-gateway';
import { USAGE_LINES_PROVIDER } from '../domain/ports';
import {
  RENEWAL_FAULT,
  RenewalService,
  type RenewalFault,
} from '../application/renewal.service';
import { ChargeService } from '../application/charge.service';
import { AttemptResolutionService } from '../application/attempt-resolution.service';
import { BillingConsumerModule } from '../billing-consumer.module';
import { BillingModule } from '../billing.module';
import { BillingWorkerModule } from '../billing-worker.module';
import { BillingLifecycle } from '../infra/billing-lifecycle';
import { TenancyLifecycleConsumer } from '../infra/tenancy.consumers';

export interface BillingTestApp extends CatalogTestApp {
  sequelize: Sequelize;
  runner: TransactionRunner;
  worker: JobWorker;
  jobs: JobsService;
  /** The payment provider at the HTTP edge of the Stripe client. */
  provider: FakeBillingProvider;
  /** S18's usage-lines provider. */
  usage: FakeUsageLines;
  renewals: RenewalService;
  charges: ChargeService;
  resolution: AttemptResolutionService;
  lifecycle: BillingLifecycle;
  /** Settable fault seam of the billing run (a crash after the Nth subscription). */
  fault: RenewalFault;
  /** Real envelopes handed to the real tenancy-lifecycle consumer. */
  tenancy: ReturnType<typeof createDelivery>;
  /** Test code may touch every table (IX.6): reads and privileged setup only, never the domain's own writes. */
  sql<T = Record<string, unknown>>(
    text: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  admin(): Promise<TestUser>;
  /** A shop whose owner is `owner` (created when not given). */
  shopWithOwner(
    owner?: TestUser,
    options?: {
      sandboxOf?: string;
      status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING';
    },
  ): Promise<{ shopId: string; owner: TestUser }>;
  member(
    shopId: string,
    role: 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER',
  ): Promise<TestUser>;
  /** The id of the seeded price of a plan (DS-1) for an interval. */
  priceId(plan: string, interval?: 'MONTH' | 'YEAR'): Promise<string>;
  /** Moves the clock and signs the given users in again (a session lives 15 minutes of the fake clock). */
  at(iso: string, ...users: TestUser[]): Promise<void>;
  /** Runs the queued jobs through the real worker (the S49 handler registration) until none is due. */
  drainJobs(): Promise<number>;
  /** Enqueues a billing run and drains the queue (the path the schedule takes). */
  runBilling(): Promise<void>;
  /** Everything the outbox holds, oldest first. */
  outbox(type?: string): Promise<
    Array<{
      type: string;
      aggregateId: string;
      /** The event's own payload. */
      payload: Record<string, any>;
      /** The whole envelope as stored. */
      envelope: Record<string, any>;
    }>
  >;
  /** Captured stdout of the structured logger (only with `structuredLogger: true`). */
  rawLogs(): string;
}

/**
 * The real app the billing specs run against: `BillingModule` (HTTP), `BillingWorkerModule` (jobs) and the tenancy
 * consumer next to the identity API and tenancy, over real Postgres and Redis and the real outbox, jobs, inbox and
 * idempotency tables, with the production prefix, pipe and filter. Faked only at the edges (S17 test-plan.md): the
 * clock, S03's R1 answers (the real tenancy tables seeded by fixtures), the provider at its HTTP edge, S18's
 * usage-lines provider and, where a scenario says so, the limiter's store.
 */
export async function createBillingApp(
  options: {
    env?: Record<string, string>;
    redisUrl?: string;
    structuredLogger?: boolean;
  } = {},
): Promise<BillingTestApp> {
  const logChunks: string[] = [];
  const stdoutSpy = options.structuredLogger
    ? jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          logChunks.push(String(chunk));
          return true;
        })
    : null;
  let provider!: FakeBillingProvider;
  let usage!: FakeUsageLines;
  const fault: RenewalFault = {};
  const base = await createCatalogApp({
    structuredLogger: options.structuredLogger,
    redisUrl: options.redisUrl,
    extraImports: [
      BillingModule,
      BillingWorkerModule,
      BillingConsumerModule,
      JobsWorkerModule.register({ loops: false }),
    ],
    customize: (builder) => {
      // The clock exists only after the base app builds its FakeClock: the doubles read it lazily.
      provider = new FakeBillingProvider({
        now: () => base_.clock.now(),
        advance: (ms) => base_.clock.advance(ms),
      });
      usage = new FakeUsageLines();
      return builder
        .overrideProvider(BILLING_PROVIDER_TRANSPORT)
        .useValue(provider)
        .overrideProvider(USAGE_LINES_PROVIDER)
        .useValue(usage)
        .overrideProvider(RENEWAL_FAULT)
        .useValue(fault);
    },
  });
  const base_ = base;
  const app: INestApplication = base.app;
  const sequelize = app.get<Sequelize>(getConnectionToken());
  const sql = <T>(text: string, replacements: Record<string, unknown> = {}) =>
    sequelize.query(text, {
      type: QueryTypes.SELECT,
      replacements,
    }) as Promise<T[]>;
  const reset = base.reset.bind(base);
  const worker = app.get(JobWorker, { strict: false });
  const jobs = app.get(JobsService, { strict: false });

  const self: BillingTestApp = {
    ...base,
    sequelize,
    runner: app.get(TransactionRunner, { strict: false }),
    worker,
    jobs,
    provider,
    usage,
    renewals: app.get(RenewalService, { strict: false }),
    charges: app.get(ChargeService, { strict: false }),
    resolution: app.get(AttemptResolutionService, { strict: false }),
    lifecycle: app.get(BillingLifecycle, { strict: false }),
    fault,
    tenancy: createDelivery(app, TenancyLifecycleConsumer),
    sql,
    rawLogs: () => logChunks.join(''),
    async close() {
      stdoutSpy?.mockRestore();
      await base.close();
    },
    async reset() {
      await reset();
      provider.reset();
      usage.reset();
      for (const key of Object.keys(fault))
        delete (fault as Record<string, unknown>)[key];
      self.lifecycle['stopping'] = false;
      // The catalog tables survive `seeds.clean()` (migration-managed reference data): put DS-1 back.
      for (const statement of DS1_SEED_SQL) await sequelize.query(statement);
      await sequelize.query(`DELETE FROM "SubjectPlanState"`);
    },
    admin: () => base.newUser({ role: Role.ADMIN }),
    async shopWithOwner(owner, shopOptions = {}) {
      const user = owner ?? (await base.newUser());
      const shop = await createShop(app, user, shopOptions);
      return { shopId: shop.id, owner: user };
    },
    async member(shopId, role) {
      const user = await base.newUser();
      await addMember(app, shopId, user.id, role);
      return user;
    },
    async priceId(plan, interval = 'MONTH') {
      const [row] = await sql<{ id: string }>(
        `SELECT pr.id FROM "Price" pr JOIN "Plan" p ON p.id = pr."planId"
          WHERE p.code = :plan AND pr."interval" = :interval AND pr.active
          ORDER BY pr."version" ASC LIMIT 1`,
        { plan, interval },
      );
      return row.id;
    },
    async at(iso, ...users) {
      base.clock.set(new Date(iso));
      for (const user of users) await base.reauth(user);
    },
    async drainJobs() {
      let total = 0;
      for (let i = 0; i < 100; i++) {
        const ran = await worker.runOnce();
        if (ran === 0) break;
        total += ran;
      }
      return total;
    },
    async runBilling() {
      await jobs.enqueue(
        'billing.run',
        {},
        { idempotencyKey: `test-run:${uuidv4()}` },
      );
      await self.drainJobs();
    },
    async outbox(type) {
      const rows = await sql<{
        type: string;
        aggregateId: string;
        payload: { payload: Record<string, any> };
      }>(
        `SELECT "type", "aggregateId", "payload" FROM "Outbox"
          WHERE (CAST(:type AS text) IS NULL OR "type" = :type) ORDER BY "createdAt", "id"`,
        { type: type ?? null },
      );
      return rows.map((row) => ({
        type: row.type,
        aggregateId: row.aggregateId,
        payload: row.payload.payload,
        envelope: row.payload,
      }));
    },
  };
  return self;
}
