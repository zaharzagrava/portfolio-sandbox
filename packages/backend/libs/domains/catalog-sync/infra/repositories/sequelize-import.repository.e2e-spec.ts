import { randomUUID } from 'node:crypto';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { importEventSchemas } from '@marketplace-sandbox/contracts';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { useEventClock } from '@app/infrastructure/events/define-event';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { CATALOG_SYNC_AGGREGATE } from '../../application/events/integration-events';
import {
  IMPORT_REPOSITORY,
  type ImportJobRecord,
  type ImportRepository,
} from '../../domain/ports';
import { SequelizeImportRepository } from './sequelize-import.repository';

const clock = new FakeClock(new Date('2026-10-16T10:00:00.000Z'));
const LEASE = 300_000;

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: clock }],
  exports: [CLOCK],
})
class TestClockModule {}

@Module({
  imports: [EventsModule.forAggregates([CATALOG_SYNC_AGGREGATE]), OutboxModule],
  providers: [
    { provide: IMPORT_REPOSITORY, useClass: SequelizeImportRepository },
  ],
  exports: [IMPORT_REPOSITORY],
})
class ImportRepositoryTestModule {}

describe('ImportJob repository (e2e)', () => {
  let app: INestApplication;
  let db: Sequelize;
  let repo: ImportRepository;
  const shops: string[] = [];
  const user = randomUUID();

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [TestClockModule, ImportRepositoryTestModule],
      { customize: (b) => b.overrideProvider(CLOCK).useValue(clock) },
    );
    app = moduleRef.createNestApplication();
    await app.init();
    useEventClock(clock);
    db = app.get(Sequelize);
    repo = app.get(IMPORT_REPOSITORY);
  });

  afterAll(async () => {
    for (const shopId of shops) {
      const [jobs] = await db.query(
        `SELECT "id" FROM "ImportJob" WHERE "shopId" = $1`,
        { bind: [shopId] },
      );
      for (const j of jobs as { id: string }[])
        await db.query(`DELETE FROM "Outbox" WHERE "aggregateId" = $1`, {
          bind: [j.id],
        });
      await db.query(`DELETE FROM "ImportJobHistory" WHERE "shopId" = $1`, {
        bind: [shopId],
      });
      await db.query(`DELETE FROM "ImportJob" WHERE "shopId" = $1`, {
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
  const insert = async (shopId: string, sizeBytes = 100) => {
    const id = uuidv7(); // production ids are v7: creation order is id order
    const r = await repo.insertPending({
      id,
      shopId,
      createdBy: user,
      fileName: 'catalog.csv',
      sizeBytes,
      storageKey: `imports/${shopId}/${id}/source`,
      now: clock.now(),
    });
    if (r.kind !== 'created') throw new Error('expected created');
    return r.job;
  };
  /** A job brought to UPLOADED the way the API does it. */
  const uploaded = async (shopId: string): Promise<ImportJobRecord> => {
    const job = await insert(shopId);
    const moved = await repo.transition({
      importId: job.id,
      shopId,
      from: 'PENDING_UPLOAD',
      to: 'UPLOADED',
      now: clock.now(),
    });
    if (!moved) throw new Error('expected UPLOADED');
    return moved;
  };
  const claim = (id: string, holder = randomUUID()) =>
    repo
      .claim({
        importId: id,
        leaseHolder: holder,
        now: clock.now(),
        leaseMs: LEASE,
      })
      .then((result) => ({ result, holder }));
  const history = async (importId: string) => {
    const [rows] = await db.query(
      `SELECT "fromStatus", "toStatus", "reason" FROM "ImportJobHistory" WHERE "importId" = $1 ORDER BY "id"`,
      { bind: [importId] },
    );
    return rows as Array<{
      fromStatus: string | null;
      toStatus: string;
      reason: string | null;
    }>;
  };
  const events = async (id: string) =>
    (await outboxRowsFor(db, id)).filter((r) => r.kind === 'event');
  const delta = (over: Partial<Record<string, number>> = {}) => ({
    rowsProcessed: 500,
    rowsCreated: 500,
    rowsUpdated: 0,
    rowsUnchanged: 0,
    rowsFailed: 0,
    ...over,
  });
  /** Claimed, still SCANNING. */
  const scanning = async () => {
    const shopId = newShop();
    const job = await uploaded(shopId);
    const { result, holder } = await claim(job.id);
    if (result.kind !== 'claimed') throw new Error('expected claim');
    return { shopId, id: job.id, holder, job: result.job };
  };
  /** Claimed and scanned clean: PROCESSING. */
  const running = async () => {
    const s = await scanning();
    const moved = await repo.transition({
      importId: s.id,
      from: 'SCANNING',
      to: 'PROCESSING',
      scan: 'clean',
      leaseHolder: s.holder,
      now: clock.now(),
    });
    if (!moved) throw new Error('expected PROCESSING');
    return { ...s, job: moved };
  };
  const commit = (
    id: string,
    holder: string,
    over: Partial<Parameters<ImportRepository['commitBatch']>[0]> = {},
  ) =>
    repo.commitBatch({
      importId: id,
      leaseHolder: holder,
      now: clock.now(),
      leaseMs: LEASE,
      delta: delta(),
      lastRow: 500,
      nextByteOffset: 40_000,
      bytesProcessed: 40_000,
      errorReportLines: 0,
      ...over,
    });

  describe('insert and cap', () => {
    it('S07 AS-01: inserts a PENDING_UPLOAD job in slot 1 with one creation history row and no outbox row', async () => {
      const shopId = newShop();
      const job = await insert(shopId);
      expect(job).toMatchObject({
        shopId,
        createdBy: user,
        status: 'PENDING_UPLOAD',
        slot: 1,
        rowsProcessed: 0,
        lastRow: 0,
        nextByteOffset: 0,
        uploadHandle: null,
        ignoredColumns: [],
        format: null,
        headerColumns: null,
        leaseHolder: null,
      });
      expect(await history(job.id)).toEqual([
        { fromStatus: null, toStatus: 'PENDING_UPLOAD', reason: null },
      ]);
      expect(await events(job.id)).toHaveLength(0);
    });

    it('S07 AS-61: five concurrent inserts for one shop make exactly three jobs, in distinct slots', async () => {
      const shopId = newShop();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => {
          const id = randomUUID();
          return repo.insertPending({
            id,
            shopId,
            createdBy: user,
            fileName: 'f.csv',
            sizeBytes: 10,
            storageKey: `imports/${shopId}/${id}/source`,
            now: clock.now(),
          });
        }),
      );
      expect(results.filter((r) => r.kind === 'created')).toHaveLength(3);
      expect(results.filter((r) => r.kind === 'cap')).toHaveLength(2);
      const [rows] = await db.query(
        `SELECT "slot" FROM "ImportJob" WHERE "shopId" = $1 ORDER BY "slot"`,
        { bind: [shopId] },
      );
      expect((rows as Array<{ slot: number }>).map((r) => r.slot)).toEqual([
        1, 2, 3,
      ]);
    });

    it('S07 AS-61: a final job frees its slot, another shop is not affected', async () => {
      const shopId = newShop();
      const a = await insert(shopId);
      await insert(shopId);
      await insert(shopId);
      expect(
        (
          await repo.insertPending({
            id: randomUUID(),
            shopId,
            createdBy: user,
            fileName: 'f',
            sizeBytes: 1,
            storageKey: 'k',
            now: clock.now(),
          })
        ).kind,
      ).toBe('cap');
      await repo.transition({
        importId: a.id,
        shopId,
        from: 'PENDING_UPLOAD',
        to: 'CANCELLED',
        reason: 'user_cancelled',
        now: clock.now(),
      });
      const again = await insert(shopId);
      expect(again.slot).toBe(1);
      expect((await insert(newShop())).slot).toBe(1);
    });

    it('S07 AS-01: the upload handle is set once, only while PENDING_UPLOAD', async () => {
      const shopId = newShop();
      const job = await insert(shopId);
      expect(
        await repo.setUploadHandle(job.id, shopId, 'h1', clock.now()),
      ).toBe(true);
      expect(
        await repo.setUploadHandle(job.id, shopId, 'h2', clock.now()),
      ).toBe(false);
      expect((await repo.findForShop(shopId, job.id))?.uploadHandle).toBe('h1');
      expect(
        await repo.setUploadHandle(job.id, randomUUID(), 'h3', clock.now()),
      ).toBe(false);
    });
  });

  describe('conditional transitions', () => {
    it('S07 AS-58: a transition applies from the expected status and writes its history row', async () => {
      const shopId = newShop();
      const job = await insert(shopId);
      const moved = await repo.transition({
        importId: job.id,
        shopId,
        from: 'PENDING_UPLOAD',
        to: 'UPLOADED',
        now: clock.now(),
      });
      expect(moved?.status).toBe('UPLOADED');
      expect(await history(job.id)).toEqual([
        { fromStatus: null, toStatus: 'PENDING_UPLOAD', reason: null },
        { fromStatus: 'PENDING_UPLOAD', toStatus: 'UPLOADED', reason: null },
      ]);
    });

    it('S07 AS-58: a stale from changes zero rows and writes no history', async () => {
      const { id, shopId } = await running();
      const stale = await repo.transition({
        importId: id,
        shopId,
        from: 'UPLOADED',
        to: 'SCANNING',
        now: clock.now(),
      });
      expect(stale).toBeNull();
      expect((await repo.findForShop(shopId, id))?.status).toBe('PROCESSING');
      expect(
        (await history(id)).filter((h) => h.toStatus === 'SCANNING'),
      ).toHaveLength(1);
    });

    it('S07 AS-52: every predicate carries the shop: another shop changes and reads nothing', async () => {
      const shopId = newShop();
      const other = newShop();
      const job = await insert(shopId);
      expect(await repo.findForShop(other, job.id)).toBeNull();
      expect(
        await repo.transition({
          importId: job.id,
          shopId: other,
          from: 'PENDING_UPLOAD',
          to: 'CANCELLED',
          now: clock.now(),
        }),
      ).toBeNull();
      expect((await repo.findForShop(shopId, job.id))?.status).toBe(
        'PENDING_UPLOAD',
      );
      expect((await repo.list(other, { limit: 20 })).items).toEqual([]);
      expect(await repo.requestCancel(other, job.id, clock.now())).toBeNull();
    });

    it('S07 AS-64: a final status writes the finished event in the same transaction, once', async () => {
      const shopId = newShop();
      const job = await insert(shopId);
      const done = await repo.transition({
        importId: job.id,
        shopId,
        from: 'PENDING_UPLOAD',
        to: 'FAILED',
        failure: { code: 'size_mismatch' },
        clearUploadHandle: true,
        now: clock.now(),
      });
      expect(done).toMatchObject({
        status: 'FAILED',
        failureCode: 'size_mismatch',
        finishedAt: clock.now(),
        uploadHandle: null,
      });
      const rows = await events(job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        topic: 'catalogsync.events',
        aggregateId: job.id,
      });
      const envelope = rows[0].payload as { type: string; payload: unknown };
      expect(envelope.type).toBe('catalogsync.import_finished');
      expect(
        importEventSchemas['catalogsync.import_finished'].parse(
          envelope.payload,
        ),
      ).toMatchObject({
        importId: job.id,
        shopId,
        status: 'FAILED',
        failureCode: 'size_mismatch',
      });
      // a repeat is a stale from: nothing more is written
      expect(
        await repo.transition({
          importId: job.id,
          shopId,
          from: 'PENDING_UPLOAD',
          to: 'FAILED',
          now: clock.now(),
        }),
      ).toBeNull();
      expect(await events(job.id)).toHaveLength(1);
    });

    it('S07 AS-64: a non-final status writes no event', async () => {
      const shopId = newShop();
      const job = await uploaded(shopId);
      expect(await events(job.id)).toHaveLength(0);
    });
  });

  describe('claim, lease and fencing', () => {
    it('S07 AS-36: the first claim moves UPLOADED to SCANNING with a lease; a second finds it held', async () => {
      const shopId = newShop();
      const job = await uploaded(shopId);
      const [a, b] = await Promise.all([claim(job.id), claim(job.id)]);
      const kinds = [a.result.kind, b.result.kind].sort();
      expect(kinds).toEqual(['claimed', 'held']);
      const winner = a.result.kind === 'claimed' ? a : b;
      const row = (await repo.findById(job.id))!;
      expect(row).toMatchObject({
        status: 'SCANNING',
        leaseHolder: winner.holder,
        leaseExpiresAt: new Date(clock.now().getTime() + LEASE),
        startedAt: clock.now(),
      });
    });

    it('S07 AS-60: a shop runs one import at a time, in creation order', async () => {
      const shopId = newShop();
      const first = await uploaded(shopId);
      const second = await uploaded(shopId);
      // the later job cannot overtake the earlier one
      expect((await claim(second.id)).result.kind).toBe('busy');
      const c1 = await claim(first.id);
      expect(c1.result.kind).toBe('claimed');
      // while the first runs, the second is busy
      expect((await claim(second.id)).result.kind).toBe('busy');
      // once the first is final the second may run
      await repo.transition({
        importId: first.id,
        from: 'SCANNING',
        to: 'FAILED',
        failure: { code: 'malware_detected' },
        leaseHolder: c1.holder,
        now: clock.now(),
      });
      expect((await claim(second.id)).result.kind).toBe('claimed');
    });

    it('S07 AS-60: another shop is not blocked by a running import', async () => {
      const a = await uploaded(newShop());
      const b = await uploaded(newShop());
      expect((await claim(a.id)).result.kind).toBe('claimed');
      expect((await claim(b.id)).result.kind).toBe('claimed');
    });

    it('S07 AS-38: a final job is reported as final, an unknown id as missing', async () => {
      const shopId = newShop();
      const job = await insert(shopId);
      await repo.transition({
        importId: job.id,
        shopId,
        from: 'PENDING_UPLOAD',
        to: 'CANCELLED',
        now: clock.now(),
      });
      expect((await claim(job.id)).result.kind).toBe('final');
      expect((await claim(randomUUID())).result.kind).toBe('missing');
    });

    it('S07 AS-37: an expired lease can be taken over, and the old holder is fenced out', async () => {
      const { id, holder: a } = await running();
      clock.advance(LEASE + 1);
      const b = await claim(id);
      expect(b.result.kind).toBe('claimed');
      // B commits batch 5
      const ok = await commit(id, b.holder, { lastRow: 500, delta: delta() });
      expect(ok?.job.rowsProcessed).toBe(500);
      // A wakes up and tries to commit
      expect(
        await commit(id, a, {
          lastRow: 1000,
          delta: delta({ rowsProcessed: 400, rowsCreated: 400 }),
        }),
      ).toBeNull();
      expect(await repo.renewLease(id, a, clock.now(), LEASE)).toBe(false);
      const row = (await repo.findById(id))!;
      expect(row).toMatchObject({
        rowsProcessed: 500,
        rowsCreated: 500,
        lastRow: 500,
        leaseHolder: b.holder,
      });
      // A cannot finish it either
      expect(
        await repo.transition({
          importId: id,
          from: 'PROCESSING',
          to: 'FAILED',
          failure: { code: 'internal_error' },
          leaseHolder: a,
          now: clock.now(),
        }),
      ).toBeNull();
    });

    it('S07 AS-36: a live lease is not taken over; renewal extends it; release clears it only for the holder', async () => {
      const { id, holder } = await running();
      expect((await claim(id)).result.kind).toBe('held');
      clock.advance(60_000);
      expect(await repo.renewLease(id, holder, clock.now(), LEASE)).toBe(true);
      expect((await repo.findById(id))!.leaseExpiresAt).toEqual(
        new Date(clock.now().getTime() + LEASE),
      );
      await repo.releaseLease(id, randomUUID());
      expect((await repo.findById(id))!.leaseHolder).toBe(holder);
      await repo.releaseLease(id, holder);
      expect(await repo.findById(id)).toMatchObject({
        leaseHolder: null,
        leaseExpiresAt: null,
        status: 'PROCESSING',
      });
    });

    it('S07 AS-21: SCANNING to PROCESSING stores the verdict and its time', async () => {
      const { id, holder } = await scanning();
      const moved = await repo.transition({
        importId: id,
        from: 'SCANNING',
        to: 'PROCESSING',
        scan: 'clean',
        leaseHolder: holder,
        now: clock.now(),
      });
      expect(moved).toMatchObject({
        status: 'PROCESSING',
        scan: 'clean',
        scannedAt: clock.now(),
        leaseHolder: holder,
      });
    });
  });

  describe('checkpoints', () => {
    it('S07 AS-33: a commit writes counters, lastRow, byte offset, header and format together and extends the lease', async () => {
      const { id, holder } = await running();
      clock.advance(10_000);
      const r = await commit(id, holder, {
        delta: delta({ rowsProcessed: 500, rowsCreated: 497, rowsFailed: 3 }),
        errorReportLines: 4,
        header: {
          format: 'csv',
          headerColumns: ['sku', 'title', 'price', 'category'],
          ignoredColumns: ['colour'],
        },
      });
      expect(r?.cancelRequested).toBe(false);
      expect(r?.job).toMatchObject({
        rowsProcessed: 500,
        rowsCreated: 497,
        rowsFailed: 3,
        lastRow: 500,
        nextByteOffset: 40_000,
        bytesProcessed: 40_000,
        errorReportRows: 4,
        format: 'csv',
        headerColumns: ['sku', 'title', 'price', 'category'],
        ignoredColumns: ['colour'],
        leaseExpiresAt: new Date(clock.now().getTime() + LEASE),
      });
      // the second commit adds up; the header stays as it was
      const second = await commit(id, holder, {
        lastRow: 1000,
        nextByteOffset: 80_000,
        bytesProcessed: 80_000,
        delta: delta({ rowsProcessed: 500, rowsUpdated: 500, rowsCreated: 0 }),
      });
      expect(second?.job).toMatchObject({
        rowsProcessed: 1000,
        rowsCreated: 497,
        rowsUpdated: 500,
        rowsFailed: 3,
        lastRow: 1000,
        nextByteOffset: 80_000,
        format: 'csv',
        ignoredColumns: ['colour'],
      });
    });

    it('S07 AS-33: the counters always add up (the table refuses a delta that does not)', async () => {
      const { id, holder } = await running();
      await expect(
        commit(id, holder, {
          delta: delta({ rowsProcessed: 500, rowsCreated: 400 }),
        }),
      ).rejects.toThrow();
      expect((await repo.findById(id))!.rowsProcessed).toBe(0);
    });

    it('S07 AS-56: a cancel request on a running job is seen by the next commit', async () => {
      const { id, shopId, holder } = await running();
      const marked = await repo.requestCancel(shopId, id, clock.now());
      expect(marked?.cancelRequestedAt).toEqual(clock.now());
      const r = await commit(id, holder);
      expect(r?.cancelRequested).toBe(true);
      // a job that is not running cannot be marked
      const pending = await insert(newShop());
      expect(
        await repo.requestCancel(pending.shopId, pending.id, clock.now()),
      ).toBeNull();
    });
  });

  describe('list', () => {
    it('S07 AS-54: pages newest first with the id as tiebreaker, no repeat or gap, with equal instants', async () => {
      const shopId = newShop();
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) {
        // equal createdAt for groups of three; final jobs do not hold slots
        if (i % 3 === 0) clock.advance(1000);
        const job = await insert(shopId);
        ids.push(job.id);
        await repo.transition({
          importId: job.id,
          shopId,
          from: 'PENDING_UPLOAD',
          to: 'CANCELLED',
          now: clock.now(),
        });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      const sizes: number[] = [];
      do {
        const page = await repo.list(shopId, { limit: 4, cursor });
        sizes.push(page.items.length);
        seen.push(...page.items.map((j) => j.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(sizes).toEqual([4, 4, 1]);
      expect(new Set(seen).size).toBe(9);
      expect([...seen].sort()).toEqual([...ids].sort());
      const rows = (await Promise.all(seen.map((id) => repo.findById(id)))).map(
        (j) => [j!.createdAt.getTime(), j!.id] as const,
      );
      const sorted = [...rows].sort(
        (x, y) => y[0] - x[0] || (x[1] < y[1] ? 1 : -1),
      );
      expect(rows).toEqual(sorted);
    });

    it('S07 AS-54: the status filter narrows the page', async () => {
      const shopId = newShop();
      const a = await insert(shopId);
      await insert(shopId);
      await repo.transition({
        importId: a.id,
        shopId,
        from: 'PENDING_UPLOAD',
        to: 'CANCELLED',
        now: clock.now(),
      });
      const page = await repo.list(shopId, { limit: 20, status: 'CANCELLED' });
      expect(page.items.map((j) => j.id)).toEqual([a.id]);
    });

    it('S07 AS-54: a tampered cursor is refused', async () => {
      const shopId = newShop();
      await insert(shopId);
      await insert(shopId);
      const page = await repo.list(shopId, { limit: 1 });
      await expect(
        repo.list(shopId, { limit: 1, cursor: `${page.nextCursor}x` }),
      ).rejects.toThrow();
      await expect(
        repo.list(shopId, { limit: 1, cursor: 'garbage' }),
      ).rejects.toThrow();
    });
  });

  describe('recovery, expiry and retention', () => {
    it('S07 AS-40: stalled jobs are claimed once per window, fresh and live ones are not', async () => {
      // (a) UPLOADED for more than 2 minutes, no lease
      const a = await uploaded(newShop());
      // (b) running, lease expired
      const b = await running();
      // b's lease runs out; a has been UPLOADED for more than 2 minutes
      clock.advance(LEASE + 1000);
      // (c) UPLOADED for 30 seconds
      const c = await uploaded(newShop());
      // (d) running, live lease
      const d = await running();
      clock.advance(30_000);
      const first = await repo.claimRecoverable(clock.now(), 100);
      const ids = first.map((j) => j.id);
      expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(ids).not.toContain(c.id);
      expect(ids).not.toContain(d.id);
      // a second run (or another instance) in the same window takes nothing
      const second = await repo.claimRecoverable(clock.now(), 100);
      expect(second.map((j) => j.id)).not.toContain(a.id);
      expect(second.map((j) => j.id)).not.toContain(b.id);
      // a later window takes them again
      clock.advance(121_000);
      const third = await repo.claimRecoverable(clock.now(), 100);
      expect(third.map((j) => j.id)).toEqual(expect.arrayContaining([a.id]));
    });

    it('S07 AS-59: only PENDING_UPLOAD jobs older than 24 hours are expirable', async () => {
      const shopId = newShop();
      const old = await insert(shopId);
      clock.advance(2 * 3_600_000);
      const young = await insert(shopId);
      clock.advance(23 * 3_600_000);
      const found = (await repo.findExpirable(clock.now(), 100)).map(
        (j) => j.id,
      );
      expect(found).toContain(old.id);
      expect(found).not.toContain(young.id);
    });

    it('S07 AS-67: purge candidates are final jobs past the cutoff, never non-final ones; delete is won once', async () => {
      const shopId = newShop();
      const job = await insert(shopId);
      await repo.transition({
        importId: job.id,
        shopId,
        from: 'PENDING_UPLOAD',
        to: 'CANCELLED',
        now: clock.now(),
      });
      await repo.setErrorReportKey(
        job.id,
        `imports/${shopId}/${job.id}/report/errors.csv`,
      );
      const open = await insert(shopId);
      clock.advance(40 * 86_400_000);
      const cutoff = new Date(clock.now().getTime() - 30 * 86_400_000);
      expect(
        (await repo.findReportPurgeable(cutoff, 500)).map((j) => j.id),
      ).toContain(job.id);
      expect(
        (await repo.findReportPurgeable(cutoff, 500)).map((j) => j.id),
      ).not.toContain(open.id);
      expect(await repo.clearReportKey(job.id)).toBe(true);
      expect(await repo.clearReportKey(job.id)).toBe(false);
      clock.advance(60 * 86_400_000);
      const old = new Date(clock.now().getTime() - 90 * 86_400_000);
      const purgeable = (await repo.findRecordPurgeable(old, 500)).map(
        (j) => j.id,
      );
      expect(purgeable).toContain(job.id);
      expect(purgeable).not.toContain(open.id);
      const results = await Promise.all([
        repo.deleteJob(job.id),
        repo.deleteJob(job.id),
      ]);
      expect(results.sort()).toEqual([false, true]);
      expect(await history(job.id)).toEqual([]);
    });

    it('S07 AS-65: non-final jobs of a shop are found; deleting a shop removes rows and history of that shop only', async () => {
      const shopId = newShop();
      const other = newShop();
      const a = await insert(shopId);
      await uploaded(shopId);
      const keep = await insert(other);
      await repo.transition({
        importId: a.id,
        shopId,
        from: 'PENDING_UPLOAD',
        to: 'CANCELLED',
        now: clock.now(),
      });
      expect((await repo.nonFinalByShop(shopId)).map((j) => j.status)).toEqual([
        'UPLOADED',
      ]);
      expect(await repo.deleteByShop(shopId)).toBe(2);
      expect(await repo.deleteByShop(shopId)).toBe(0);
      expect(await repo.findById(a.id)).toBeNull();
      expect(await repo.findById(keep.id)).not.toBeNull();
    });

    it('S07 AS-68: the age of the oldest running checkpoint is reported', async () => {
      await running();
      clock.advance(30_000);
      expect(
        await repo.oldestCheckpointAgeMs(clock.now()),
      ).toBeGreaterThanOrEqual(30_000);
    });
  });
});
