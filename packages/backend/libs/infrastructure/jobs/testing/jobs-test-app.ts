import { Global, INestApplication, Module, Provider } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import type { Sequelize } from 'sequelize';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { ApiConfigService } from '@app/common/config';
import { RequestContext } from '@app/infrastructure/context';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { JobsService } from '../jobs.service';
import { JobWorker } from '../job-worker.service';
import { JobMaintenance } from '../job-maintenance.service';
import { JobReaper } from '../job-reaper.service';
import { JobRegistry } from '../job-registry.service';
import { JobsWorkerModule } from '../jobs-worker.module';

/** Frozen "now" of every jobs spec; moved with `clock.advance()`. */
export const JOBS_TEST_START = new Date('2026-10-09T10:00:00.000Z');

export interface JobsTestAppOptions {
  /** Handlers and helpers of the spec. */
  providers?: Provider[];
  /** Start the background loops (default false: specs drive ticks by hand). */
  loops?: boolean;
  start?: Date;
  /** More Nest modules of the app under test (for example a module with its own handlers and schedules). */
  modules?: unknown[];
  /** Empty the job tables once the app is up (default true); false keeps what the modules registered at boot. */
  resetAfterBoot?: boolean;
}

export interface JobsTestApp {
  app: INestApplication;
  clock: FakeClock;
  sequelize: Sequelize;
  config: MockApiConfigService;
  jobs: JobsService;
  worker: JobWorker;
  maintenance: JobMaintenance;
  reaper: JobReaper;
  get<T>(token: unknown): T;
  /** Another worker over the same database and handlers: its own worker id, its own in-flight bookkeeping. */
  newWorker(): JobWorker;
  /** Another maintenance instance (a second replica) over the same database. */
  newMaintenance(): JobMaintenance;
  /** Empties the job tables and resets the clock and the config. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boots the real `JobsWorkerModule` against the real test Postgres with a frozen clock. Only handler bodies (the spec's
 * providers) are fakes. `reset()` truncates the three job tables so a spec starts from nothing.
 */
export async function createJobsTestApp(
  options: JobsTestAppOptions = {},
): Promise<JobsTestApp> {
  const clock = new FakeClock(options.start ?? JOBS_TEST_START);

  @Global()
  @Module({
    providers: [{ provide: CLOCK, useValue: clock }],
    exports: [CLOCK],
  })
  class TestClockModule {}

  @Module({ providers: options.providers ?? [] })
  class SpecModule {}

  const moduleRef = await generateTestingModule(
    [
      TestClockModule,
      JobsWorkerModule.register({ loops: options.loops ?? false }),
      ...((options.modules ?? []) as never[]),
      SpecModule,
    ],
    { customize: (b) => b.overrideProvider(CLOCK).useValue(clock) },
  );
  const app = moduleRef.createNestApplication();
  await app.init();

  const sequelize = app.get<Sequelize>(getConnectionToken());
  const config = app.get(ApiConfigService) as MockApiConfigService;
  const reaper = app.get(JobReaper);
  const test: JobsTestApp = {
    app,
    clock,
    sequelize,
    config,
    jobs: app.get(JobsService),
    worker: app.get(JobWorker),
    maintenance: app.get(JobMaintenance),
    reaper,
    get: <T>(token: unknown) => app.get<T>(token as never),
    newWorker: () =>
      new JobWorker(
        sequelize,
        app.get(JobRegistry),
        app.get(RequestContext),
        app.get(TransactionRunner),
        config,
        clock,
        { loops: false },
      ),
    newMaintenance: () =>
      new JobMaintenance(
        sequelize,
        app.get(TransactionRunner),
        reaper,
        config,
        clock,
        { loops: false },
      ),
    async reset() {
      clock.set(options.start ?? JOBS_TEST_START);
      config.reset();
      await sequelize.query(`TRUNCATE "Job", "JobKey", "JobSchedule"`);
    },
    async close() {
      await app.close();
    },
  };
  if (options.resetAfterBoot ?? true) await test.reset();
  return test;
}
