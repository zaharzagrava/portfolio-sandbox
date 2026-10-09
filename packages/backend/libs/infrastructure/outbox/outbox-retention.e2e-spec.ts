import { INestApplication, Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { JobRegistry } from '@app/infrastructure/jobs/job-registry.service';
import { OutboxMaintenanceModule } from './outbox-maintenance.module';
import {
  OutboxPurgeService,
  PURGE_PUBLISHED_JOB,
} from './outbox-purge.service';

const clock = new FakeClock(new Date('2026-10-09T10:00:00.000Z'));

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: clock }],
  exports: [CLOCK],
})
class TestClockModule {}

/** Only the handler registry of the job system: discovers `@JobHandler`s without starting a job worker. */
@Module({
  imports: [DiscoveryModule],
  providers: [JobRegistry],
  exports: [JobRegistry],
})
class TestJobRegistryModule {}

describe('Outbox retention of published rows', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let purge: OutboxPurgeService;
  const DAY = 86_400_000;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [
        TestClockModule,
        JobsModule,
        TestJobRegistryModule,
        OutboxMaintenanceModule,
      ],
      { customize: (b) => b.overrideProvider(CLOCK).useValue(clock) },
    );
    app = moduleRef.createNestApplication();
    await app.init();
    sequelize = app.get(Sequelize);
    purge = app.get(OutboxPurgeService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await sequelize.query(`DELETE FROM "Outbox" WHERE "topic" = 'retn.events'`);
  });

  const insert = (
    count: number,
    status: string,
    publishedAt: Date | null,
    tag: string,
  ) =>
    sequelize.query(
      `INSERT INTO "Outbox" ("id", "kind", "topic", "aggregateId", "aggregateType", "type", "payload", "status", "attempts", "nextAttemptAt", "createdAt", "publishedAt", "parkedReason")
       SELECT uuidv7(), 'event', 'retn.events', $1 || g, 'retn', 'retn.thing', jsonb_build_object('eventId', uuidv7(), 'tag', $1), $2, 0, $3, $3, $4, CASE WHEN $2 = 'parked' THEN 'MAX_ATTEMPTS' END
       FROM generate_series(1, $5::int) g`,
      {
        bind: [
          tag,
          status,
          new Date(clock.nowMs() - 30 * DAY),
          publishedAt,
          count,
        ],
      },
    );
  const count = async (where: string) =>
    Number(
      (
        (
          await sequelize.query(
            `SELECT count(*)::int AS n FROM "Outbox" WHERE "topic" = 'retn.events' AND ${where}`,
          )
        )[0] as { n: number }[]
      )[0].n,
    );

  it('S53 AS-24: only published rows older than 7 days are deleted, 1,000 per batch, and a second run deletes nothing', async () => {
    await insert(
      1_500,
      'published',
      new Date(clock.nowMs() - 8 * DAY),
      'old-published',
    );
    await insert(
      10,
      'published',
      new Date(clock.nowMs() - 6 * DAY),
      'recent-published',
    );
    await insert(5, 'pending', null, 'old-pending');
    await insert(5, 'parked', null, 'old-parked');

    expect(await purge.purgeBatch()).toBe(1_000);
    expect(await count(`"payload"->>'tag' = 'old-published'`)).toBe(500);

    expect(await purge.run()).toBe(500);

    expect(await count(`"payload"->>'tag' = 'old-published'`)).toBe(0);
    expect(await count(`"payload"->>'tag' = 'recent-published'`)).toBe(10);
    expect(await count(`"status" = 'pending'`)).toBe(5);
    expect(await count(`"status" = 'parked'`)).toBe(5);

    expect(await purge.run()).toBe(0);
  });

  it('S53 AS-24: the boundary follows the injected clock: a row published exactly 7 days ago stays, one second older goes', async () => {
    await insert(
      1,
      'published',
      new Date(clock.nowMs() - 7 * DAY),
      'edge-stays',
    );
    await insert(
      1,
      'published',
      new Date(clock.nowMs() - 7 * DAY - 1_000),
      'edge-goes',
    );

    expect(await purge.run()).toBe(1);

    expect(await count(`"payload"->>'tag' = 'edge-stays'`)).toBe(1);
    expect(await count(`"payload"->>'tag' = 'edge-goes'`)).toBe(0);
  });

  it('S53 AS-24: the purge is registered as a single-run job handler and a schedule with the job system', async () => {
    const handler = app.get(JobRegistry).get(PURGE_PUBLISHED_JOB);
    expect(handler).toBeDefined();
    expect(handler!.concurrency).toBe(1);
    const [schedules] = await sequelize.query(
      `SELECT "name", "jobType", "enabled" FROM "JobSchedule" WHERE "name" = $1`,
      { bind: [PURGE_PUBLISHED_JOB] },
    );
    expect(schedules).toEqual([
      {
        name: PURGE_PUBLISHED_JOB,
        jobType: PURGE_PUBLISHED_JOB,
        enabled: true,
      },
    ]);
  });

  it('S53 AS-24: nothing deleted when no row is old enough', async () => {
    await insert(3, 'published', new Date(clock.nowMs() - DAY), 'fresh');
    expect(await purge.run()).toBe(0);
    expect(await count(`"payload"->>'tag' = 'fresh'`)).toBe(3);
  });
});
