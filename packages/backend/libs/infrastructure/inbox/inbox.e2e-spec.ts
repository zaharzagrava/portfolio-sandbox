import { INestApplication, Global, Module } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { TransactionRunner } from '@app/infrastructure/context';
import { InboxModule } from './inbox.module';
import { InboxService, InboxStatus } from './inbox.service';
import { InboxPurgeService } from './inbox-purge.service';

const clock = new FakeClock(new Date('2026-10-09T10:00:00.000Z'));
const MIN = 60_000;
const DAY = 86_400_000;

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: clock }],
  exports: [CLOCK],
})
class TestClockModule {}

describe('Inbox: claim an external event once, record a consumed event once', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let inbox: InboxService;
  let purge: InboxPurgeService;
  let runner: TransactionRunner;
  const source = `spec-${uuidv7().slice(-6)}`;
  let seq = 0;
  const eventId = () => `evt_${++seq}_${uuidv7().slice(-6)}`;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [TestClockModule, InboxModule],
      {
        customize: (b) => b.overrideProvider(CLOCK).useValue(clock),
      },
    );
    app = moduleRef.createNestApplication();
    await app.init();
    sequelize = app.get(Sequelize);
    inbox = app.get(InboxService);
    purge = app.get(InboxPurgeService);
    runner = app.get(TransactionRunner);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    clock.set(new Date('2026-10-09T10:00:00.000Z'));
    await sequelize.query(
      `DELETE FROM "ProcessedWebhookEvent" WHERE "provider" LIKE 'spec-%'`,
    );
  });

  type Row = {
    provider: string;
    eventId: string;
    status: string;
    attempts: number;
    claimedAt: Date | null;
    handledAt: Date | null;
  };
  const rows = async (id?: string) =>
    (
      await sequelize.query(
        `SELECT * FROM "ProcessedWebhookEvent" WHERE "provider" = $1 ${id ? 'AND "eventId" = $2' : ''} ORDER BY "eventId"`,
        { bind: id ? [source, id] : [source] },
      )
    )[0] as Row[];

  it('S53 AS-44: a new pair is CLAIMED with status RECEIVED, attempts 1, and exactly one row exists', async () => {
    const id = eventId();

    const result = await inbox.claim(source, id);

    expect(result).toEqual({
      outcome: 'CLAIMED',
      status: 'RECEIVED',
      attempts: 1,
    });
    const stored = await rows(id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: 'RECEIVED', attempts: 1 });
    expect(new Date(stored[0].claimedAt!).toISOString()).toBe(
      '2026-10-09T10:00:00.000Z',
    );
  });

  it('S53 AS-45: two concurrent claims of the same pair give one CLAIMED and one DUPLICATE_IN_PROGRESS, one row', async () => {
    const id = eventId();

    const results = await Promise.all([
      inbox.claim(source, id),
      inbox.claim(source, id),
    ]);

    expect(results.map((r) => r.outcome).sort()).toEqual([
      'CLAIMED',
      'DUPLICATE_IN_PROGRESS',
    ]);
    expect(await rows(id)).toHaveLength(1);
    expect((await rows(id))[0].attempts).toBe(1);
  });

  it('S53 AS-45: twenty concurrent claims still produce a single CLAIMED', async () => {
    const id = eventId();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => inbox.claim(source, id)),
    );
    expect(results.filter((r) => r.outcome === 'CLAIMED')).toHaveLength(1);
    expect(
      results.filter((r) => r.outcome === 'DUPLICATE_IN_PROGRESS'),
    ).toHaveLength(19);
  });

  it.each<InboxStatus>(['PROCESSED', 'IGNORED', 'UNMATCHED', 'REJECTED'])(
    'S53 AS-46: a claim marked %s answers DUPLICATE_DONE with that status and nothing changes',
    async (status) => {
      const id = eventId();
      await inbox.claim(source, id);
      await inbox.markStatus(source, id, status);
      const before = await rows(id);

      const again = await inbox.claim(source, id);

      expect(again).toEqual({ outcome: 'DUPLICATE_DONE', status, attempts: 1 });
      expect(await rows(id)).toEqual(before);
    },
  );

  it('S53 AS-46: markStatus stamps the handling time and keeps a short detail, never a payload', async () => {
    const id = eventId();
    await inbox.claim(source, id);
    clock.advance(5_000);
    await inbox.markStatus(source, id, 'REJECTED', 'UNKNOWN_PAYMENT');
    const [row] = await sequelize
      .query(
        `SELECT "status", "handledAt", "detail" FROM "ProcessedWebhookEvent" WHERE "provider" = $1 AND "eventId" = $2`,
        { bind: [source, id] },
      )
      .then(
        ([r]) => r as { status: string; handledAt: Date; detail: string }[],
      );
    expect(row.status).toBe('REJECTED');
    expect(new Date(row.handledAt).toISOString()).toBe(
      '2026-10-09T10:00:05.000Z',
    );
    expect(row.detail).toBe('UNKNOWN_PAYMENT');
  });

  it('S53 AS-47: a FAILED claim is claimable again with attempts 2', async () => {
    const id = eventId();
    await inbox.claim(source, id);
    await inbox.markStatus(source, id, 'FAILED', 'DOWNSTREAM_UNAVAILABLE');

    const again = await inbox.claim(source, id);

    expect(again).toEqual({
      outcome: 'CLAIMED',
      status: 'RECEIVED',
      attempts: 2,
    });
    expect(await rows(id)).toHaveLength(1);
  });

  it('S53 AS-47: a claim still RECEIVED after the 5-minute lease is reclaimed with attempts incremented, a younger one is not', async () => {
    const id = eventId();
    await inbox.claim(source, id); // the handler crashes here

    clock.advance(4 * MIN + 59_000);
    expect((await inbox.claim(source, id)).outcome).toBe(
      'DUPLICATE_IN_PROGRESS',
    );

    clock.advance(2_000); // 5 min 1 s after the claim
    const reclaimed = await inbox.claim(source, id);

    expect(reclaimed).toEqual({
      outcome: 'CLAIMED',
      status: 'RECEIVED',
      attempts: 2,
    });
    // the lease restarted with the reclaim
    expect((await inbox.claim(source, id)).outcome).toBe(
      'DUPLICATE_IN_PROGRESS',
    );
  });

  it('S53 AS-48: purge deletes only terminal rows older than 30 days, in batches of at most 1,000, never RECEIVED rows by age', async () => {
    const old = new Date(clock.nowMs() - 31 * DAY);
    const recent = new Date(clock.nowMs() - 29 * DAY);
    await sequelize.query(
      `INSERT INTO "ProcessedWebhookEvent" ("provider", "eventId", "status", "attempts", "claimedAt", "handledAt", "createdAt", "processedAt")
       SELECT $1, 'old-' || g, 'PROCESSED', 1, $2, $2, $2, $2 FROM generate_series(1, 1500) g`,
      { bind: [source, old] },
    );
    await sequelize.query(
      `INSERT INTO "ProcessedWebhookEvent" ("provider", "eventId", "status", "attempts", "claimedAt", "handledAt", "createdAt", "processedAt")
       VALUES ($1, 'recent', 'PROCESSED', 1, $2, $2, $2, $2), ($1, 'old-received', 'RECEIVED', 1, $3, NULL, $3, $3), ($1, 'old-failed', 'FAILED', 1, $3, $3, $3, $3)`,
      { bind: [source, recent, old] },
    );
    const cutoff = new Date(clock.nowMs() - 30 * DAY);

    expect(await inbox.purge(cutoff)).toBe(1_000);
    expect(await purge.run()).toBe(500);

    const left = (await rows()).map((r) => r.eventId);
    expect(left.sort()).toEqual(['old-failed', 'old-received', 'recent']);
    expect(await purge.run()).toBe(0);
  });

  it('S53 AS-49: recordOnce rolls back with the caller and commits with it', async () => {
    const id = eventId();

    await expect(
      runner.run(async () => {
        expect(await inbox.recordOnce(source, id)).toBe(true);
        throw new Error('handler failed after the record');
      }),
    ).rejects.toThrow('handler failed');
    expect(await rows(id)).toHaveLength(0);

    // a retry is treated as new again
    await runner.run(async () => {
      expect(await inbox.recordOnce(source, id)).toBe(true);
    });
    expect(await rows(id)).toHaveLength(1);
    expect((await rows(id))[0].status).toBe('PROCESSED');

    await runner.run(async () => {
      expect(await inbox.recordOnce(source, id)).toBe(false);
    });
    expect(await rows(id)).toHaveLength(1);
  });

  it('S53 AS-49: recordOnce outside a transaction is refused: the record must commit with the effect', async () => {
    await expect(inbox.recordOnce(source, eventId())).rejects.toThrow(
      /transaction/,
    );
  });

  it('S53 AS-49: the same event id for two consumers is recorded once per consumer', async () => {
    const id = eventId();
    await runner.run(async () => {
      expect(await inbox.recordOnce(`${source}-a`, id)).toBe(true);
      expect(await inbox.recordOnce(`${source}-b`, id)).toBe(true);
      expect(await inbox.recordOnce(`${source}-a`, id)).toBe(false);
    });
    await sequelize.query(
      `DELETE FROM "ProcessedWebhookEvent" WHERE "provider" IN ($1, $2)`,
      {
        bind: [`${source}-a`, `${source}-b`],
      },
    );
  });

  it('S53 AS-44: rows written by the pre-S53 webhook handler (provider and event id only) count as processed duplicates', async () => {
    const id = eventId();
    await sequelize.query(
      `INSERT INTO "ProcessedWebhookEvent" ("provider", "eventId") VALUES ($1, $2)`,
      { bind: [source, id] },
    );
    expect(await inbox.claim(source, id)).toMatchObject({
      outcome: 'DUPLICATE_DONE',
      status: 'PROCESSED',
    });
  });
});
