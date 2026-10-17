import { v4 as uuidv4 } from 'uuid';
import { leaderboardPageSchema } from '@marketplace-sandbox/contracts';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { JobMaintenance } from '@app/infrastructure/jobs/job-maintenance.service';
import { JobReaper } from '@app/infrastructure/jobs/job-reaper.service';
import { JobsWorkerModule } from '@app/infrastructure/jobs/jobs-worker.module';
import { ApiConfigService } from '@app/common/config';
import type { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { getConnectionToken } from '@nestjs/sequelize';
import type { Sequelize } from 'sequelize';
import { BoardProjector } from './infra/projectors/board.projector';
import { ShopNameProjector } from './infra/projectors/read-model.projectors';
import {
  SNAPSHOT_MONTHLY,
  SNAPSHOT_WEEKLY,
  SnapshotJobs,
} from './infra/snapshot.jobs';
import {
  createInsightsApp,
  T0,
  type InsightsTestApp,
} from './testing/insights-fixtures';

describe('Leaderboards: period snapshots', () => {
  let t: InsightsTestApp;

  beforeAll(async () => {
    t = await createInsightsApp({
      extraImports: [JobsWorkerModule.register({ loops: false })],
    });
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const boards = () => t.projector(BoardProjector);
  const sell = (
    shopId: string,
    productId: string,
    total: number,
    paidAt: string,
  ) =>
    t.paid({ paidAt, lines: [{ shopId, productId, lineTotalMinor: total }] });
  const clockAt = (iso: string) => t.clock.set(new Date(iso));
  const topList = async (id: string, limit = 100) => {
    const res = await t
      .http()
      .get(`/api/leaderboards?period=week&id=${id}&limit=${limit}`)
      .expect(200);
    return leaderboardPageSchema.parse(res.body);
  };

  /** 101 shops on the overall board of 2026-W40 (month 2026-09), three of them known by name, three categories' worth of data. */
  const seedWeek40 = async () => {
    const named = [
      await t.readModelShop('Alpha'),
      await t.readModelShop('Beta'),
      await t.readModelShop('Gamma'),
    ];
    const electronics = await t.product(named[0].shopId, 'electronics');
    const accessories = await t.product(named[0].shopId, 'accessories');
    const unknownProduct = uuidv4();
    const anonymous = Array.from({ length: 98 }, () => uuidv4());
    const events = [
      ...named.map((s, i) =>
        sell(s.shopId, electronics, 5000 + i * 10, '2026-09-30T10:00:00Z'),
      ),
      ...named
        .slice(0, 2)
        .map((s, i) =>
          sell(s.shopId, accessories, 300 + i, '2026-09-30T10:05:00Z'),
        ),
      ...anonymous.map((shopId, i) =>
        sell(shopId, unknownProduct, 100 + i, '2026-09-30T11:00:00Z'),
      ),
    ];
    for (let i = 0; i < events.length; i += 25)
      await t.deliver(boards(), events.slice(i, i + 25));
    return { named, anonymous };
  };

  describe('AS-31: a closed period is frozen', () => {
    it('S40 AS-31: one hour after week 2026-W40 ends the job stores the top 100 of its three boards with names, revenue and participants', async () => {
      const { named } = await seedWeek40();
      clockAt('2026-10-05T01:00:00Z');

      const results = await t.runSnapshotJob('week');

      expect(results).toEqual([
        { periodId: '2026-W40', boards: 3, rows: 100 + 3 + 2 },
      ]);
      const overall = await t.snapshotRows('2026-W40', 'all');
      expect(overall).toHaveLength(100);
      expect(overall.every((r) => r.participants === 101)).toBe(true);
      expect(overall.map((r) => r.rank)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 1),
      );
      expect(
        overall.slice(0, 3).map((r) => [r.shopId, r.shopName, r.revenue]),
      ).toEqual([
        [named[1].shopId, 'Beta', 5010 + 301],
        [named[0].shopId, 'Alpha', 5000 + 300],
        [named[2].shopId, 'Gamma', 5020],
      ]);
      expect(overall.at(-1)!.shopName).toBeNull();
      expect(
        (await t.snapshotRows('2026-W40', 'cat:electronics')).map((r) => [
          r.rank,
          r.shopName,
          r.revenue,
          r.participants,
        ]),
      ).toEqual([
        [1, 'Gamma', 5020, 3],
        [2, 'Beta', 5010, 3],
        [3, 'Alpha', 5000, 3],
      ]);
      expect(
        (await t.snapshotRows('2026-W40', 'cat:accessories')).map((r) => [
          r.rank,
          r.shopName,
          r.revenue,
          r.participants,
        ]),
      ).toEqual([
        [1, 'Beta', 301, 2],
        [2, 'Alpha', 300, 2],
      ]);
      expect(await t.redis.exists(`lb:{2026-W40}:sealed`)).toBe(1);
    });

    it('S40 AS-31: the monthly job freezes month 2026-09 at 2026-10-01 01:00', async () => {
      const a = await t.readModelShop('Alpha');
      const p = await t.product(a.shopId, 'electronics');
      await t.deliver(boards(), [
        sell(a.shopId, p, 1200, '2026-09-10T10:00:00Z'),
      ]);
      clockAt('2026-10-01T01:00:00Z');

      const results = await t.runSnapshotJob('month');

      expect(results).toEqual([{ periodId: '2026-09', boards: 2, rows: 2 }]);
      expect(
        (await t.snapshotRows('2026-09', 'all')).map((r) => [
          r.rank,
          r.shopName,
          r.revenue,
          r.participants,
        ]),
      ).toEqual([[1, 'Alpha', 1200, 1]]);
    });
  });

  describe('AS-32: a period that is not closed is refused', () => {
    it('S40 AS-32: before end plus one hour the freeze is refused with period_not_closed and nothing is stored', async () => {
      await seedWeek40();
      clockAt('2026-10-05T00:59:59Z');

      await expect(t.freeze('2026-W40')).rejects.toMatchObject({
        code: 'period_not_closed',
      });

      expect(await t.snapshotRows('2026-W40', 'all')).toEqual([]);
      expect(await t.redis.exists(`lb:{2026-W40}:sealed`)).toBe(0);
    });

    it('S40 AS-32: the current week, a future week and a malformed id are refused; an existing snapshot is untouched', async () => {
      await seedWeek40();
      clockAt('2026-10-05T01:00:00Z');
      await t.freeze('2026-W40');
      const stored = await t.snapshotRows('2026-W40', 'all');
      clockAt(T0.toISOString());

      await expect(t.freeze('2026-W41')).rejects.toMatchObject({
        code: 'period_not_closed',
      });
      await expect(t.freeze('2026-W50')).rejects.toMatchObject({
        code: 'period_not_closed',
      });
      await expect(t.freeze('2026-10')).rejects.toMatchObject({
        code: 'period_not_closed',
      });
      await expect(t.freeze('abc')).rejects.toMatchObject({
        code: 'invalid_period',
      });
      await expect(t.freeze('2026-W54')).rejects.toMatchObject({
        code: 'invalid_period',
      });

      expect(await t.snapshotRows('2026-W40', 'all')).toEqual(stored);
      expect(await t.snapshotRows('2026-W41', 'all')).toEqual([]);
      expect(await t.snapshotRows('2026-W50', 'all')).toEqual([]);
    });
  });

  describe('AS-33: re-run, concurrent run, readers', () => {
    it('S40 AS-33: a re-run and two runs at once leave the same rows while a reader polling the list never sees an empty or partial one', async () => {
      await seedWeek40();
      clockAt('2026-10-05T01:00:00Z');
      await t.freeze('2026-W40');
      const first = {
        all: await t.snapshotRows('2026-W40', 'all'),
        electronics: await t.snapshotRows('2026-W40', 'cat:electronics'),
        accessories: await t.snapshotRows('2026-W40', 'cat:accessories'),
      };
      let polling = true;
      const seen: number[] = [];
      const reader = (async () => {
        while (polling) {
          seen.push((await topList('2026-W40')).entries.length);
          await new Promise((r) => setTimeout(r, 5));
        }
      })();

      await t.freeze('2026-W40');
      for (let round = 0; round < 6; round++)
        await Promise.all([t.freeze('2026-W40'), t.freeze('2026-W40')]);
      polling = false;
      await reader;

      expect(seen.length).toBeGreaterThan(5);
      expect(new Set(seen)).toEqual(new Set([100]));
      expect({
        all: await t.snapshotRows('2026-W40', 'all'),
        electronics: await t.snapshotRows('2026-W40', 'cat:electronics'),
        accessories: await t.snapshotRows('2026-W40', 'cat:accessories'),
      }).toEqual(first);
      for (const rows of Object.values(first))
        expect(rows.map((r) => r.rank)).toEqual(
          Array.from({ length: rows.length }, (_, i) => i + 1),
        );
    });
  });

  describe('AS-34: catch-up', () => {
    it('S40 AS-34: a run freezes every closed unfrozen week that still has boards, oldest first; a period without boards is skipped with one warning and stores no rows', async () => {
      const a = await t.readModelShop('Alpha');
      const p = await t.product(a.shopId, 'electronics');
      await t.deliver(boards(), [
        sell(a.shopId, p, 700, '2026-09-22T10:00:00Z'),
        sell(a.shopId, p, 900, '2026-09-30T10:00:00Z'),
      ]);
      clockAt('2026-10-05T01:00:00Z');

      const results = await t.runSnapshotJob('week');

      expect(results.map((r) => r.periodId)).toEqual(['2026-W39', '2026-W40']);
      expect(
        (await t.snapshotRows('2026-W39', 'all')).map((r) => r.revenue),
      ).toEqual([700]);
      expect(
        (await t.snapshotRows('2026-W40', 'all')).map((r) => r.revenue),
      ).toEqual([900]);
      const skipped = t
        .logs()
        .filter(
          (l) =>
            l.line.event === 'snapshot_skipped_no_boards' &&
            l.line.period === '2026-W38',
        );
      expect(skipped).toHaveLength(1);
      expect(await t.snapshotRows('2026-W38', 'all')).toEqual([]);
      // nothing is frozen twice: the next run finds nothing to do
      expect(await t.runSnapshotJob('week')).toEqual([]);
    });
  });

  describe('AS-35: registration', () => {
    it('S40 AS-35: three boots leave exactly two schedules with the cron expressions; two replicas firing one schedule run it once', async () => {
      const connection = t.app.get<Sequelize>(getConnectionToken(), {
        strict: false,
      });
      await connection.query(
        `INSERT INTO "JobSchedule" ("name", "cron", "timezone", "jobType", "payload", "enabled", "overlap", "maxAttempts", "nextFireAt")
         VALUES ('leaderboards.snapshot-week', '0 1 * * 1', 'UTC', 'leaderboards.snapshot', '{"kind":"week"}', TRUE, 'skip', 3, now())`,
      );
      const boot = () => t.app.get(SnapshotJobs).onApplicationBootstrap();

      await boot();
      await boot();
      await boot();

      const schedules = await t.pg<{
        name: string;
        cron: string;
        payload: unknown;
        timezone: string;
        jobType: string;
      }>(
        `SELECT "name", "cron", "payload", "timezone", "jobType" FROM "JobSchedule" ORDER BY "name"`,
      );
      expect(
        schedules.map((s) => [
          s.name,
          s.cron,
          s.timezone,
          s.jobType,
          s.payload,
        ]),
      ).toEqual([
        [
          SNAPSHOT_MONTHLY,
          '0 1 1 * *',
          'UTC',
          'leaderboards.snapshot',
          { kind: 'month' },
        ],
        [
          SNAPSHOT_WEEKLY,
          '0 1 * * 1',
          'UTC',
          'leaderboards.snapshot',
          { kind: 'week' },
        ],
      ]);

      const [weekly] = await t.pg<{ nextFireAt: string }>(
        `SELECT "nextFireAt" FROM "JobSchedule" WHERE "name" = :name`,
        { name: SNAPSHOT_WEEKLY },
      );
      expect(new Date(weekly.nextFireAt).toISOString()).toBe(
        '2026-10-12T01:00:00.000Z',
      );
      t.clock.set(new Date(weekly.nextFireAt));
      const sequelize = connection;
      const first = t.app.get(JobMaintenance);
      const second = new JobMaintenance(
        sequelize as never,
        t.app.get(TransactionRunner),
        t.app.get(JobReaper),
        t.app.get(ApiConfigService) as unknown as MockApiConfigService as never,
        t.clock,
        { loops: false },
      );
      const fired = await Promise.all([
        first.materializeDueSchedules(),
        second.materializeDueSchedules(),
      ]);
      expect(fired.reduce((a, b) => a + b, 0)).toBe(1);
      const jobs = await t.pg<{ type: string; idempotencyKey: string }>(
        `SELECT "type", "idempotencyKey" FROM "Job" ORDER BY "runAt"`,
      );
      expect(jobs).toEqual([
        {
          type: 'leaderboards.snapshot',
          idempotencyKey: `cron:${SNAPSHOT_WEEKLY}:2026-10-12T01:00:00.000Z`,
        },
      ]);
    });
  });

  describe('AS-36: a snapshot is a historical record', () => {
    it('S40 AS-36: a rename after the freeze does not change the list; a shop unknown at snapshot time is stored with a null name and stays listed', async () => {
      const a = await t.readModelShop('Alpha');
      const stranger = uuidv4();
      const p = await t.product(a.shopId, 'electronics');
      await t.deliver(boards(), [
        sell(a.shopId, p, 900, '2026-09-30T10:00:00Z'),
        sell(stranger, p, 400, '2026-09-30T10:01:00Z'),
      ]);
      clockAt('2026-10-05T01:00:00Z');
      await t.freeze('2026-W40');
      clockAt(T0.toISOString());

      await t.deliver(t.projector(ShopNameProjector), [
        t.shopUpdated({
          shopId: a.shopId,
          name: 'Alpha Renamed',
          slug: 'alpha-renamed',
          shopVersion: 2,
        }),
      ]);
      await t.deliver(t.projector(ShopNameProjector), [
        t.shopCreated({
          shopId: stranger,
          name: 'Late Name',
          slug: 'late',
          shopVersion: 1,
        }),
      ]);

      const page = await topList('2026-W40');
      expect(page.source).toBe('snapshot');
      expect(page.entries.map((e) => [e.rank, e.shopId, e.name])).toEqual([
        [1, a.shopId, 'Alpha'],
        [2, stranger, null],
      ]);
      expect((await t.snapshotRows('2026-W40')).map((r) => r.shopName)).toEqual(
        ['Alpha', null],
      );
    });
  });
});
