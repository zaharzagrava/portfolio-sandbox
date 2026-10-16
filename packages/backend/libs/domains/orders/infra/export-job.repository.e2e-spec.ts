import { randomUUID } from 'node:crypto';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { CLOCK as CORE_CLOCK, FakeClock } from '@app/common/core/clock';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { useEventClock } from '@app/infrastructure/events/define-event';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { ORDER_EXPORT_AGGREGATE } from '../application/events/order-export-finished.event';
import { CLOCK, EXPORT_JOBS } from '../domain/export-ports';
import type { ExportJobRecord, ExportJobsPort } from '../domain/export-ports';
import { SequelizeExportJobRepository } from './export-job.repository';

const clock = new FakeClock(new Date('2026-10-16T10:00:00.000Z'));
const LEASE = 300_000;
const DAY = 86_400_000;

@Global()
@Module({
  providers: [
    { provide: CORE_CLOCK, useValue: clock },
    { provide: CLOCK, useValue: clock },
  ],
  exports: [CORE_CLOCK, CLOCK],
})
class TestClockModule {}

@Module({
  imports: [EventsModule.forAggregates([ORDER_EXPORT_AGGREGATE]), OutboxModule],
  providers: [{ provide: EXPORT_JOBS, useClass: SequelizeExportJobRepository }],
  exports: [EXPORT_JOBS],
})
class ExportRepositoryTestModule {}

describe('ExportJob repository (e2e)', () => {
  let app: INestApplication;
  let db: Sequelize;
  let repo: ExportJobsPort;
  const shops: string[] = [];
  const user = randomUUID();

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [TestClockModule, ExportRepositoryTestModule],
      { customize: (b) => b.overrideProvider(CORE_CLOCK).useValue(clock) },
    );
    app = moduleRef.createNestApplication();
    await app.init();
    useEventClock(clock);
    db = app.get(Sequelize);
    repo = app.get(EXPORT_JOBS);
  });

  afterAll(async () => {
    for (const shopId of shops) {
      const [jobs] = await db.query(
        `SELECT "id" FROM "ExportJob" WHERE "shopId" = $1`,
        { bind: [shopId] },
      );
      for (const j of jobs as { id: string }[])
        await db.query(`DELETE FROM "Outbox" WHERE "aggregateId" = $1`, {
          bind: [j.id],
        });
      await db.query(`DELETE FROM "ExportJobHistory" WHERE "shopId" = $1`, {
        bind: [shopId],
      });
      await db.query(`DELETE FROM "ExportJob" WHERE "shopId" = $1`, {
        bind: [shopId],
      });
    }
    await app.close();
  });

  beforeEach(() => clock.set(new Date('2026-10-16T10:00:00.000Z')));

  const newShop = () => {
    const id = randomUUID();
    shops.push(id);
    return id;
  };
  const create = async (shopId: string): Promise<ExportJobRecord> => {
    const r = await repo.createWithActiveGuard({
      shopId,
      createdBy: user,
      now: clock.now(),
    });
    if (r.kind !== 'created') throw new Error('expected created');
    return r.job;
  };
  const claim = async (id: string) => {
    const leaseHolder = randomUUID();
    const job = await repo.claim({
      exportId: id,
      leaseHolder,
      leaseExpiresAt: new Date(clock.now().getTime() + LEASE),
      now: clock.now(),
    });
    return { job, leaseHolder };
  };
  const finish = (
    id: string,
    leaseHolder: string | null,
    extra: Partial<Parameters<ExportJobsPort['finish']>[0]> = {},
  ) =>
    repo.finish({
      exportId: id,
      leaseHolder,
      to: 'DONE',
      fileKey: 'exports/k.csv',
      rowsWritten: 1,
      bytesWritten: 1,
      now: clock.now(),
      ...extra,
    });
  const cancel = (shopId: string, exportId: string, actor: string | null) =>
    repo.cancel({
      shopId,
      exportId,
      actor,
      reason: 'user_cancelled',
      now: clock.now(),
    });
  const history = async (exportId: string) => {
    const [rows] = await db.query(
      `SELECT "fromStatus", "toStatus", "reason", "actor" FROM "ExportJobHistory" WHERE "exportId" = $1 ORDER BY "at", "id"`,
      { bind: [exportId] },
    );
    return rows as {
      fromStatus: string | null;
      toStatus: string;
      reason: string | null;
      actor: string | null;
    }[];
  };
  const events = async (id: string) =>
    (await outboxRowsFor(db, id)).filter((r) => r.kind === 'event');
  const running = async () => {
    const shopId = newShop();
    const job = await create(shopId);
    const { leaseHolder } = await claim(job.id);
    return { shopId, id: job.id, holder: leaseHolder };
  };

  describe('create with the active guard', () => {
    it('inserts a QUEUED job with one creation history row and no outbox row', async () => {
      const shopId = newShop();
      const job = await create(shopId);
      expect(job).toMatchObject({
        shopId,
        createdBy: user,
        status: 'QUEUED',
        attempt: 0,
        totalRows: null,
        rowsWritten: 0,
        bytesWritten: 0,
        leaseHolder: null,
        createdAt: clock.now(),
      });
      expect(await history(job.id)).toEqual([
        { fromStatus: null, toStatus: 'QUEUED', reason: null, actor: user },
      ]);
      expect(await events(job.id)).toHaveLength(0);
    });

    it('refuses a second active export of the shop with the winner id, and writes nothing for the loser', async () => {
      const shopId = newShop();
      const winner = await create(shopId);
      await expect(
        repo.createWithActiveGuard({
          shopId,
          createdBy: user,
          now: clock.now(),
        }),
      ).resolves.toEqual({ kind: 'active', activeExportId: winner.id });
      const [rows] = await db.query(
        `SELECT count(*)::int AS n FROM "ExportJobHistory" WHERE "shopId" = $1`,
        { bind: [shopId] },
      );
      expect((rows as { n: number }[])[0].n).toBe(1);
    });

    it('lets concurrent creates produce exactly one winner, all losers naming it', async () => {
      const shopId = newShop();
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          repo.createWithActiveGuard({
            shopId,
            createdBy: user,
            now: clock.now(),
          }),
        ),
      );
      const created = results.filter((r) => r.kind === 'created');
      expect(created).toHaveLength(1);
      const winnerId = (created[0] as { job: ExportJobRecord }).job.id;
      for (const r of results)
        if (r.kind === 'active') expect(r.activeExportId).toBe(winnerId);
    });

    it('frees the slot after the job finishes, and other shops are unaffected', async () => {
      const shopId = newShop();
      const first = await create(shopId);
      await expect(create(newShop())).resolves.toBeDefined();
      await cancel(shopId, first.id, user);
      await expect(create(shopId)).resolves.toBeDefined();
    });
  });

  describe('claim', () => {
    it('moves QUEUED to RUNNING once: attempt + 1, the given lease, startedAt, history', async () => {
      const job = await create(newShop());
      const { job: claimed, leaseHolder } = await claim(job.id);
      expect(claimed).toMatchObject({
        status: 'RUNNING',
        attempt: 1,
        leaseHolder,
        startedAt: clock.now(),
      });
      expect(claimed!.leaseExpiresAt!.getTime()).toBe(
        clock.now().getTime() + LEASE,
      );
      expect((await claim(job.id)).job).toBeNull(); // duplicate delivery
      expect((await history(job.id)).at(-1)).toMatchObject({
        fromStatus: 'QUEUED',
        toStatus: 'RUNNING',
      });
    });

    it('returns null for an unknown id', async () => {
      expect((await claim(randomUUID())).job).toBeNull();
    });
  });

  describe('fenced writes', () => {
    const leaseEnd = () => new Date(clock.now().getTime() + LEASE);

    it('heartbeat extends the lease only for the holder', async () => {
      const { shopId, id, holder } = await running();
      clock.advance(60_000);
      expect(await repo.heartbeat(id, holder, leaseEnd())).toBe(true);
      expect((await repo.findByShop(shopId, id))!.leaseExpiresAt).toEqual(
        leaseEnd(),
      );
      const before = await repo.findByShop(shopId, id);
      expect(await repo.heartbeat(id, randomUUID(), leaseEnd())).toBe(false);
      expect(await repo.findByShop(shopId, id)).toEqual(before);
    });

    it('a stale lease holder changes nothing: progress, finish, requeue', async () => {
      const { shopId, id } = await running();
      const stale = randomUUID();
      const before = await repo.findByShop(shopId, id);
      const historyBefore = await history(id);
      expect(
        await repo.recordProgress(id, stale, {
          rowsWritten: 5,
          bytesWritten: 50,
        }),
      ).toBe(false);
      expect(await finish(id, stale)).toBe(false);
      expect(
        await repo.requeue({
          exportId: id,
          leaseHolder: stale,
          reason: 'shutdown',
          restoreAttempt: true,
          now: clock.now(),
        }),
      ).toBe(false);
      expect(await repo.findByShop(shopId, id)).toEqual(before);
      expect(await history(id)).toEqual(historyBefore);
      expect(await events(id)).toHaveLength(0);
    });

    it('refuses writes once the lease has expired, even from the holder', async () => {
      const { id, holder } = await running();
      clock.advance(LEASE + 1);
      expect(await repo.heartbeat(id, holder, leaseEnd())).toBe(false);
      expect(
        await repo.recordProgress(id, holder, {
          rowsWritten: 1,
          bytesWritten: 1,
        }),
      ).toBe(false);
      expect(await finish(id, holder)).toBe(false);
    });

    it('recordProgress stores counters and totalRows', async () => {
      const { shopId, id, holder } = await running();
      expect(
        await repo.recordProgress(id, holder, {
          rowsWritten: 10,
          bytesWritten: 100,
          totalRows: 50,
        }),
      ).toBe(true);
      expect(await repo.findByShop(shopId, id)).toMatchObject({
        rowsWritten: 10,
        bytesWritten: 100,
        totalRows: 50,
      });
    });

    it('requeue returns the job to QUEUED, clears the lease, restores the attempt on request, and writes no event', async () => {
      const { shopId, id, holder } = await running();
      expect(
        await repo.requeue({
          exportId: id,
          leaseHolder: holder,
          reason: 'shutdown',
          restoreAttempt: true,
          now: clock.now(),
        }),
      ).toBe(true);
      expect(await repo.findByShop(shopId, id)).toMatchObject({
        status: 'QUEUED',
        attempt: 0,
        leaseHolder: null,
        leaseExpiresAt: null,
      });
      expect((await history(id)).at(-1)).toMatchObject({
        fromStatus: 'RUNNING',
        toStatus: 'QUEUED',
        reason: 'shutdown',
        actor: null,
      });
      expect(await events(id)).toHaveLength(0);
      const again = await claim(id);
      expect(
        await repo.requeue({
          exportId: id,
          leaseHolder: again.leaseHolder,
          reason: 'retry',
          restoreAttempt: false,
          now: clock.now(),
        }),
      ).toBe(true);
      expect((await repo.findByShop(shopId, id))!.attempt).toBe(1);
    });
  });

  describe('worker reads', () => {
    it('findById is unscoped by shop; readLease reports status and token validity', async () => {
      const { id, holder } = await running();
      expect(await repo.findById(id)).toMatchObject({ id, status: 'RUNNING' });
      expect(await repo.findById(randomUUID())).toBeNull();
      expect(await repo.readLease(id, holder)).toEqual({
        status: 'RUNNING',
        leaseValid: true,
      });
      expect(await repo.readLease(id, randomUUID())).toEqual({
        status: 'RUNNING',
        leaseValid: false,
      });
      clock.advance(LEASE + 1);
      expect((await repo.readLease(id, holder))!.leaseValid).toBe(false);
      expect(await repo.readLease(randomUUID(), holder)).toBeNull();
    });

    it('requeue resets the counters and totalRows; finish honours an explicit expiresAt', async () => {
      const { shopId, id, holder } = await running();
      await repo.recordProgress(id, holder, {
        rowsWritten: 9,
        bytesWritten: 90,
        totalRows: 20,
      });
      await repo.requeue({
        exportId: id,
        leaseHolder: holder,
        reason: 'retry',
        restoreAttempt: false,
        now: clock.now(),
      });
      expect(await repo.findByShop(shopId, id)).toMatchObject({
        rowsWritten: 0,
        bytesWritten: 0,
        totalRows: null,
      });
      const again = await claim(id);
      const expiresAt = new Date(clock.now().getTime() + 3 * DAY);
      await finish(id, again.leaseHolder, { expiresAt });
      expect((await repo.findByShop(shopId, id))!.expiresAt).toEqual(expiresAt);
    });
  });

  describe('outbox row only on DONE, FAILED, CANCELLED', () => {
    it('DONE: one event with the contract payload, history row, finishedAt, expiresAt in the future', async () => {
      const shopId = newShop();
      const job = await create(shopId);
      const { leaseHolder } = await claim(job.id);
      clock.advance(1000);
      expect(
        await finish(job.id, leaseHolder, {
          rowsWritten: 7,
          bytesWritten: 700,
        }),
      ).toBe(true);
      const done = (await repo.findByShop(shopId, job.id))!;
      expect(done).toMatchObject({
        status: 'DONE',
        rowsWritten: 7,
        bytesWritten: 700,
        fileKey: 'exports/k.csv',
        leaseHolder: null,
        leaseExpiresAt: null,
        finishedAt: clock.now(),
      });
      expect(done.expiresAt!.getTime()).toBeGreaterThan(clock.now().getTime());
      const rows = await events(job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].topic).toBe('order_exports.events');
      expect(rows[0].type).toBe('orderexport.finished');
      expect((rows[0].payload as { payload: unknown }).payload).toMatchObject({
        exportId: job.id,
        shopId,
        createdBy: user,
        status: 'DONE',
        failureCode: null,
        rowsWritten: 7,
        bytesWritten: 700,
        attempt: 1,
      });
      expect((await history(job.id)).at(-1)).toMatchObject({
        fromStatus: 'RUNNING',
        toStatus: 'DONE',
      });
      // a late duplicate finish changes nothing and writes no second event
      expect(
        await finish(job.id, leaseHolder, {
          to: 'FAILED',
          failureCode: 'internal_error',
        }),
      ).toBe(false);
      expect(await events(job.id)).toHaveLength(1);
    });

    it('FAILED carries the failure code; CANCELLED while running clears the lease so the worker is fenced out', async () => {
      const shopId = newShop();
      const failing = await create(shopId);
      const first = await claim(failing.id);
      await finish(failing.id, first.leaseHolder, {
        to: 'FAILED',
        failureCode: 'storage_unavailable',
        fileKey: undefined,
        rowsWritten: 3,
        bytesWritten: 30,
      });
      expect(await repo.findByShop(shopId, failing.id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'storage_unavailable',
      });
      const failed = (await events(failing.id))[0].payload as {
        payload: { failureCode: string; status: string };
      };
      expect(failed.payload).toMatchObject({
        status: 'FAILED',
        failureCode: 'storage_unavailable',
      });

      const second = await create(shopId);
      const claimed = await claim(second.id);
      expect(await cancel(shopId, second.id, user)).toMatchObject({
        status: 'CANCELLED',
        leaseHolder: null,
      });
      expect(
        await repo.recordProgress(second.id, claimed.leaseHolder, {
          rowsWritten: 1,
          bytesWritten: 1,
        }),
      ).toBe(false);
      expect(await events(second.id)).toHaveLength(1);
      expect((await history(second.id)).at(-1)).toMatchObject({
        fromStatus: 'RUNNING',
        toStatus: 'CANCELLED',
        actor: user,
        reason: 'user_cancelled',
      });
    });

    it('cancelling a QUEUED job works; cancelling a finished job returns null and writes nothing more', async () => {
      const shopId = newShop();
      const job = await create(shopId);
      expect(await cancel(shopId, job.id, null)).toMatchObject({
        status: 'CANCELLED',
      });
      expect(await events(job.id)).toHaveLength(1);
      expect(await cancel(shopId, job.id, null)).toBeNull();
      expect(await events(job.id)).toHaveLength(1);
      expect(await history(job.id)).toHaveLength(2);
    });

    it('a failing final transition leaves neither the row change nor the event', async () => {
      const shopId = newShop();
      const job = await create(shopId);
      const { leaseHolder } = await claim(job.id);
      await expect(
        finish(job.id, leaseHolder, { rowsWritten: -1 }), // invalid event payload: the transaction aborts
      ).rejects.toBeDefined();
      expect(await repo.findByShop(shopId, job.id)).toMatchObject({
        status: 'RUNNING',
      });
      expect(await events(job.id)).toHaveLength(0);
      expect(await history(job.id)).toHaveLength(2);
    });
  });

  describe('recovery, expiry, purge', () => {
    it('an expired lease is found; a null holder finishes it only when the lease is over, with an event', async () => {
      const shopId = newShop();
      const job = await create(shopId);
      await claim(job.id);
      const ids = async () =>
        (await repo.findExpiredLeases(clock.now(), 1000)).map((j) => j.id);
      expect(await ids()).not.toContain(job.id);
      expect(
        await finish(job.id, null, {
          to: 'FAILED',
          failureCode: 'attempts_exhausted',
          fileKey: undefined,
          reason: 'attempts_exhausted',
        }),
      ).toBe(false); // lease still valid
      clock.advance(LEASE + 1);
      expect(await ids()).toContain(job.id);
      expect(
        await finish(job.id, null, {
          to: 'FAILED',
          failureCode: 'attempts_exhausted',
          fileKey: undefined,
          reason: 'attempts_exhausted',
        }),
      ).toBe(true);
      expect(await repo.findByShop(shopId, job.id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'attempts_exhausted',
      });
      expect(await events(job.id)).toHaveLength(1);
    });

    it('requeue with a null holder works on an expired lease only', async () => {
      const shopId = newShop();
      const job = await create(shopId);
      await claim(job.id);
      const requeue = () =>
        repo.requeue({
          exportId: job.id,
          leaseHolder: null,
          reason: 'lease_expired',
          restoreAttempt: false,
          now: clock.now(),
        });
      expect(await requeue()).toBe(false);
      clock.advance(LEASE + 1);
      expect(await requeue()).toBe(true);
      expect((await repo.findByShop(shopId, job.id))!.status).toBe('QUEUED');
      expect(await events(job.id)).toHaveLength(0);
    });

    it('findUnclaimed lists QUEUED jobs untouched since the cutoff', async () => {
      const job = await create(newShop());
      const at = (offset: number) => new Date(clock.now().getTime() + offset);
      expect(
        (await repo.findUnclaimed(at(-1000), 1000)).map((j) => j.id),
      ).not.toContain(job.id);
      expect(
        (await repo.findUnclaimed(at(121_000), 1000)).map((j) => j.id),
      ).toContain(job.id);
    });

    it('markExpired moves DONE to EXPIRED with history, no event, and drops the file key; purge removes old jobs and history', async () => {
      const shopId = newShop();
      const job = await create(shopId);
      const { leaseHolder } = await claim(job.id);
      await finish(job.id, leaseHolder);
      const doneIds = async (offset: number) =>
        (
          await repo.findDoneBefore(
            new Date(clock.now().getTime() + offset),
            1000,
          )
        ).map((j) => j.id);
      expect(await doneIds(-1000)).not.toContain(job.id);
      expect(await doneIds(7 * DAY)).toContain(job.id);
      expect(await repo.markExpired(job.id, clock.now())).toBe(true);
      expect(await repo.markExpired(job.id, clock.now())).toBe(false);
      expect(await repo.findByShop(shopId, job.id)).toMatchObject({
        status: 'EXPIRED',
      });
      expect((await history(job.id)).at(-1)).toMatchObject({
        fromStatus: 'DONE',
        toStatus: 'EXPIRED',
      });
      expect(await events(job.id)).toHaveLength(1); // only the DONE one

      const finished = async (offset: number) =>
        (
          await repo.findFinishedBefore(
            new Date(clock.now().getTime() + offset),
            1000,
          )
        ).map((j) => j.id);
      expect(await finished(-1000)).not.toContain(job.id);
      expect(await finished(90 * DAY)).toContain(job.id);
      await repo.purge(job.id);
      expect(await repo.findByShop(shopId, job.id)).toBeNull();
      expect(await history(job.id)).toHaveLength(0);
    });

    it('findActiveByShop lists QUEUED and RUNNING only; deleteByShop removes every job and history row of the shop, returns the file keys, leaves other shops', async () => {
      const shopId = newShop();
      const other = newShop();
      const keep = await create(other);
      const a = await create(shopId);
      const claimed = await claim(a.id);
      expect((await repo.findActiveByShop(shopId)).map((j) => j.id)).toEqual([
        a.id,
      ]);
      await finish(a.id, claimed.leaseHolder, { fileKey: 'exports/a.csv' });
      expect(await repo.findActiveByShop(shopId)).toHaveLength(0);
      for (let i = 0; i < 3; i++) {
        const j = await create(shopId);
        await cancel(shopId, j.id, null);
      }
      const { fileKeys } = await repo.deleteByShop(shopId);
      expect(fileKeys).toEqual(['exports/a.csv']);
      expect((await repo.list(shopId, { limit: 10 })).items).toHaveLength(0);
      const [h] = await db.query(
        `SELECT count(*)::int AS n FROM "ExportJobHistory" WHERE "shopId" = $1`,
        { bind: [shopId] },
      );
      expect((h as { n: number }[])[0].n).toBe(0);
      expect(await repo.findByShop(other, keep.id)).not.toBeNull();
    });
  });

  describe('shop predicate on every read', () => {
    it('findByShop and cancel with another shop id see nothing; list is per shop, newest first, keyset paged, filterable', async () => {
      const shopId = newShop();
      const foreign = newShop();
      const a = await create(shopId);
      expect(await repo.findByShop(foreign, a.id)).toBeNull();
      expect(await cancel(foreign, a.id, user)).toBeNull();
      expect((await repo.findByShop(shopId, a.id))!.status).toBe('QUEUED');

      await cancel(shopId, a.id, user);
      clock.advance(1000);
      const b = await create(shopId);
      await cancel(shopId, b.id, user);
      clock.advance(1000);
      const c = await create(shopId);

      const page1 = await repo.list(shopId, { limit: 2 });
      expect(page1.items.map((i) => i.id)).toEqual([c.id, b.id]);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await repo.list(shopId, {
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2.items.map((i) => i.id)).toEqual([a.id]);
      expect(page2.nextCursor).toBeNull();
      expect(
        (await repo.list(shopId, { limit: 10, status: 'CANCELLED' })).items,
      ).toHaveLength(2);
      expect((await repo.list(foreign, { limit: 10 })).items).toHaveLength(0);
      // a cursor from one shop never leaks rows of another
      expect(
        (await repo.list(foreign, { limit: 10, cursor: page1.nextCursor! }))
          .items,
      ).toHaveLength(0);
    });
  });
});
