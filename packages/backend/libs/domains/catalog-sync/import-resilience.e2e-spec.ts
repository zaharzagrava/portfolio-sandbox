import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { importMessageSchema } from '@marketplace-sandbox/contracts';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ImportInterruptedError } from './domain/import-errors';
import {
  DAY,
  MIN,
  catalogCsv,
  createImportApp,
  type ImportKit,
  type Seller,
} from './testing/import-kit';

const LEASE = 5 * MIN;

/** The byte right after the header and the first `records` records (the checkpoint a worker stops at). */
const endOf = (file: Buffer, records: number): number => {
  let seen = 0;
  for (let i = 0; i < file.length; i++)
    if (file[i] === 0x0a && ++seen === records + 1) return i + 1;
  return file.length;
};

describe('Bulk import resilience', () => {
  let kit: ImportKit;
  const shops: string[] = [];

  beforeAll(async () => {
    kit = await createImportApp({ env: { IMPORT_ERROR_CAP: '5' } });
  });
  afterAll(async () => {
    await kit.db.query(
      `DROP TRIGGER IF EXISTS import_test_fault ON "ImportJob"`,
    );
    await kit.forget(shops);
    await kit.close();
  });
  beforeEach(async () => {
    await dropFault();
    await kit.reset();
  });
  afterEach(async () => {
    await dropFault();
    kit.probe.release();
    jest.restoreAllMocks();
    await kit.forget(shops.splice(0));
  });

  const seller = async (): Promise<Seller> => {
    const s = await kit.seller();
    shops.push(s.shop.id);
    return s;
  };
  const waitFor = async (check: () => Promise<boolean>, ms = 20_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('condition not reached in time');
  };
  /** A real database fault: the checkpoint commit that reaches `lastRow` fails as a statement timeout would (L-013: dropped after). */
  const installFault = (lastRow: number) =>
    kit.db.query(`
      CREATE OR REPLACE FUNCTION import_test_fault() RETURNS trigger AS $$
      BEGIN
        IF NEW."lastRow" = ${lastRow} AND OLD."lastRow" <> NEW."lastRow" THEN
          RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = '57014';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS import_test_fault ON "ImportJob";
      CREATE TRIGGER import_test_fault BEFORE UPDATE ON "ImportJob"
        FOR EACH ROW EXECUTE FUNCTION import_test_fault();`);
  const dropFault = () =>
    kit.db
      ? kit.db.query(`DROP TRIGGER IF EXISTS import_test_fault ON "ImportJob"`)
      : Promise.resolve();
  const snapshot = (products: Awaited<ReturnType<ImportKit['productsOf']>>) =>
    [...products.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sku, p]) => [sku, p.title, p.priceMinor, p.quantity]);
  const counters = (j: Awaited<ReturnType<ImportKit['job']>>) => ({
    rowsProcessed: j.rowsProcessed,
    rowsCreated: j.rowsCreated,
    rowsUpdated: j.rowsUpdated,
    rowsUnchanged: j.rowsUnchanged,
    rowsFailed: j.rowsFailed,
  });
  /** What an uninterrupted run of the same file produces. */
  const cleanRun = async (file: Buffer) => {
    const s = await seller();
    const id = await kit.uploaded(s, file);
    await kit.deliver(id);
    return {
      job: await kit.job(id),
      products: await kit.productsOf(s.shop.id),
    };
  };
  /** Starts a run that a frozen stream holds right after the checkpoint at `records`; waits until the checkpoint is committed. */
  const holdAt = async (
    runner: ReturnType<ImportKit['newRunner']>,
    id: string,
    file: Buffer,
    records: number,
    deliveries = 1,
  ) => {
    kit.probe.freezeAfter(endOf(file, records), { once: true, skip: 2 });
    const running = runner.handle(id, deliveries).catch((e: unknown) => e);
    await kit.probe.reached;
    const committed = Math.floor(records / 500) * 500; // checkpoints sit on batch boundaries
    await waitFor(async () => (await kit.job(id)).lastRow >= committed);
    return { running }; // wrapped: returning the pending run itself would make this helper wait for it
  };
  const skuNumber = (sku: string) => Number(sku.split('-')[1]);

  it('S07 AS-33: after batch 3 the row holds counters, lastRow, byte offset, header and format together, and progress followed each commit', async () => {
    const s = await seller();
    const file = catalogCsv(3000);
    const id = await kit.uploaded(s, file);
    const a = kit.newRunner();
    const { running } = await holdAt(a, id, file, 1500);
    const cut = endOf(file, 1500);
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'PROCESSING',
      rowsProcessed: 1500,
      rowsCreated: 1500,
      lastRow: 1500,
      nextByteOffset: cut,
      bytesProcessed: cut,
      format: 'csv',
      headerColumns: [
        'sku',
        'title',
        'description',
        'price',
        'stock',
        'category',
        'brand',
      ],
    });
    const progress = kit.rt.of(id).filter((e) => e.type === 'progress');
    expect(progress).toHaveLength(3);
    expect(progress.at(-1)!.data).toEqual({
      processed: 1500,
      failed: 0,
      bytesProcessed: cut,
      sizeBytes: file.length,
    });
    expect(progress.every((e) => e.replay === false)).toBe(true);
    await a.shutdown();
    kit.probe.release();
  }, 60_000);

  it('S07 AS-34: a redelivery reads from the stored byte offset (a range), does not scan again, sends no row at or before lastRow, and ends equal to an uninterrupted run', async () => {
    const s = await seller();
    const file = catalogCsv(3000);
    const id = await kit.uploaded(s, file);
    const a = kit.newRunner();
    const { running: first } = await holdAt(a, id, file, 1500);
    await a.shutdown();
    kit.probe.release();
    expect(await first).toBeInstanceOf(ImportInterruptedError);
    const cut = endOf(file, 1500);
    expect(await kit.job(id)).toMatchObject({
      status: 'PROCESSING',
      lastRow: 1500,
      nextByteOffset: cut,
      leaseHolder: null,
    });

    kit.resetCalls();
    const scans = kit.clamd.connections;
    const readsBefore = kit.probe.sources().length;
    expect(await kit.newRunner().handle(id, 2)).toBe('done');

    const newReads = kit.probe.sources().slice(readsBefore);
    expect(newReads.map((r) => r.start)).toEqual([cut]); // one read, from the checkpoint, no sniff, no scan
    expect(kit.clamd.connections).toBe(scans);
    const sent = kit.catalogCalls().flatMap((c) => c.skus.map(skuNumber));
    expect(Math.min(...sent)).toBe(1501);
    expect(sent).toHaveLength(1500);

    const job = await kit.job(id);
    const clean = await cleanRun(file);
    expect(job).toMatchObject({ status: 'DONE', bytesProcessed: file.length });
    expect(counters(job)).toEqual(counters(clean.job));
    expect(snapshot(await kit.productsOf(s.shop.id))).toEqual(
      snapshot(clean.products),
    );
  }, 90_000);

  it('S07 AS-35: a failure between the catalog write and the checkpoint re-sends that batch; the final state equals an uninterrupted run within the one-batch bound', async () => {
    const s = await seller();
    const file = catalogCsv(3000);
    const id = await kit.uploaded(s, file);
    await installFault(2000);
    await expect(kit.deliver(id, 1)).rejects.toThrow();
    // the catalog applied batch 4, the checkpoint did not move
    expect(await kit.job(id)).toMatchObject({
      status: 'PROCESSING',
      lastRow: 1500,
      rowsProcessed: 1500,
      leaseHolder: null,
    });
    expect((await kit.productsOf(s.shop.id)).size).toBe(2000);
    await dropFault();

    expect(await kit.deliver(id, 2)).toBe('done');
    const job = await kit.job(id);
    const clean = await cleanRun(file);
    expect(job.rowsProcessed).toBe(3000);
    expect(job.rowsFailed).toBe(clean.job.rowsFailed);
    expect(
      job.rowsCreated + job.rowsUpdated + job.rowsUnchanged + job.rowsFailed,
    ).toBe(job.rowsProcessed);
    // at most the 500 rows of that one batch moved from created to unchanged
    expect(job.rowsUnchanged).toBeLessThanOrEqual(500);
    expect(job.rowsCreated).toBe(3000 - job.rowsUnchanged);
    expect(snapshot(await kit.productsOf(s.shop.id))).toEqual(
      snapshot(clean.products),
    );
  }, 90_000);

  it('S07 AS-36: two deliveries of one job: one runs, the other returns without reading, writing or publishing anything', async () => {
    const s = await seller();
    const file = catalogCsv(1000);
    const id = await kit.uploaded(s, file);
    const a = kit.newRunner();
    const b = kit.newRunner();
    const { running: first } = await holdAt(a, id, file, 500);
    const readsBefore = kit.probe.reads.length;
    const callsBefore = kit.catalogCalls().length;
    const eventsBefore = kit.rt.events.length;
    expect(await b.handle(id, 1)).toBe('held');
    expect(kit.probe.reads.length).toBe(readsBefore);
    expect(kit.catalogCalls().length).toBe(callsBefore);
    expect(kit.rt.events.length).toBe(eventsBefore);
    const holder = (await kit.job(id)).leaseHolder;
    expect(holder).not.toBeNull();

    kit.probe.release();
    expect(await first).toBe('done');
    const clean = await cleanRun(file);
    expect(counters(await kit.job(id))).toEqual(counters(clean.job));
  }, 60_000);

  it('S07 AS-37: a worker that stalled past its lease is fenced: the new worker finishes, the old one commits nothing and stops', async () => {
    const s = await seller();
    const file = catalogCsv(3000);
    const id = await kit.uploaded(s, file);
    const a = kit.newRunner();
    const { running: aRun } = await holdAt(a, id, file, 1500);
    const before = await kit.job(id);

    kit.clock.advance(LEASE + 1000); // A is silent for longer than its lease
    const b = kit.newRunner();
    expect(await b.handle(id, 2)).toBe('done');
    const finished = await kit.job(id);
    expect(finished).toMatchObject({ status: 'DONE', rowsProcessed: 3000 });
    expect(finished.rowsProcessed).toBeGreaterThanOrEqual(before.rowsProcessed);

    kit.probe.release(); // A wakes and tries to carry on
    expect(await aRun).toBe('lost');
    const after = await kit.job(id);
    expect(counters(after)).toEqual(counters(finished));
    expect(after.status).toBe('DONE');
    expect(
      (await kit.history(id)).filter((h) => h.toStatus === 'DONE'),
    ).toHaveLength(1);
    expect(await kit.finishedEvents(id)).toHaveLength(1);
  }, 90_000);

  it('S07 AS-38: a message for a DONE, FAILED, CANCELLED or EXPIRED job is acknowledged with no read, no catalog call, no change and no event', async () => {
    const s = await seller();
    const done = await kit.uploaded(s, catalogCsv(5));
    await kit.deliver(done);
    const failed = await kit.uploaded(s, Buffer.from('sku,title\nA,B\n'));
    await kit.deliver(failed);
    const cancelled = await kit.uploaded(s, catalogCsv(5, { prefix: 'C' }));
    expect(
      (
        await kit
          .as(s.owner)
          .post(`/api/shops/${s.shop.id}/imports/${cancelled}/cancel`)
      ).status,
    ).toBe(200);
    const pending = randomUUID();
    await kit.repo.insertPending({
      id: pending,
      shopId: s.shop.id,
      createdBy: s.owner.id,
      fileName: 'x.csv',
      sizeBytes: 10,
      storageKey: `imports/${s.shop.id}/${pending}/source`,
      now: kit.clock.now(),
    });
    kit.clock.advance(25 * 60 * MIN);
    await kit.lifecycle.expirePending();

    const cases: Array<[string, string]> = [
      ['DONE', done],
      ['FAILED', failed],
      ['CANCELLED', cancelled],
      ['EXPIRED', pending],
    ];
    for (const [status, id] of cases) {
      const snapshotOf = async () => ({
        job: await kit.job(id),
        history: await kit.history(id),
        events: await kit.finishedEvents(id),
      });
      const before = await snapshotOf();
      expect(before.job.status).toBe(status);
      const reads = kit.probe.reads.length;
      const calls = kit.catalogCalls().length;
      const live = kit.rt.events.length;
      const scans = kit.clamd.connections;
      expect(await kit.deliver(id, 2)).toBe('final');
      expect(await snapshotOf()).toEqual(before);
      expect(kit.probe.reads.length).toBe(reads);
      expect(kit.catalogCalls().length).toBe(calls);
      expect(kit.rt.events.length).toBe(live);
      expect(kit.clamd.connections).toBe(scans);
      expect(before.events).toHaveLength(1);
    }
  }, 60_000);

  it('S07 AS-39: on shutdown mid-batch the run stops at its last checkpoint within 10 seconds: streams closed, lease released, the job still PROCESSING', async () => {
    const s = await seller();
    const file = catalogCsv(3000);
    const id = await kit.uploaded(s, file);
    const a = kit.newRunner();
    const { running } = await holdAt(a, id, file, 700);
    // the freeze point is inside batch 2: batch 1 is committed, batch 2 is not
    await waitFor(async () => (await kit.job(id)).lastRow === 500);
    const stoppedAt = Date.now();
    await a.shutdown();
    expect(Date.now() - stoppedAt).toBeLessThan(10_000);
    kit.probe.release();
    expect(await running).toBeInstanceOf(ImportInterruptedError);
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'PROCESSING',
      lastRow: 500,
      rowsProcessed: 500,
      leaseHolder: null,
      leaseExpiresAt: null,
    });
    expect((await kit.productsOf(s.shop.id)).size).toBe(500);
    expect(kit.probe.sources().at(-1)!.stream.destroyed).toBe(true);
    expect(kit.clamd.openSockets).toBe(0);
    // control is returned: the message is redelivered and another worker finishes it
    expect(await kit.newRunner().handle(id, 2)).toBe('done');
    expect((await kit.job(id)).rowsProcessed).toBe(3000);
  }, 60_000);

  it('S07 AS-40: lost work is put back on the queue once per window; fresh jobs and live leases are left alone, on one instance or two', async () => {
    const s1 = await seller();
    const s2 = await seller();
    const s3 = await seller();
    const s4 = await seller();
    const a = await kit.uploaded(s1, catalogCsv(3)); // message lost: UPLOADED for more than two minutes, no lease
    const b = await kit.uploaded(s2, catalogCsv(3));
    const claimedB = await kit.repo.claim({
      importId: b,
      leaseHolder: randomUUID(),
      now: kit.clock.now(),
      leaseMs: LEASE,
    });
    expect(claimedB.kind).toBe('claimed'); // its lease will have run out
    kit.clock.advance(LEASE + 1000);
    const c = await kit.uploaded(s3, catalogCsv(3)); // UPLOADED for 30 seconds
    const d = await kit.uploaded(s4, catalogCsv(3));
    expect(
      (
        await kit.repo.claim({
          importId: d,
          leaseHolder: randomUUID(),
          now: kit.clock.now(),
          leaseMs: LEASE,
        })
      ).kind,
    ).toBe('claimed'); // live lease
    kit.clock.advance(30_000);
    kit.enqueued.length = 0;

    const [r1, r2] = await Promise.all([
      kit.lifecycle.recoverStalled(),
      kit.lifecycle.recoverStalled(),
    ]);
    expect(r1.enqueued + r2.enqueued).toBe(2);
    const sent = kit.enqueued
      .map((m) => (m.body as { importId: string }).importId)
      .sort();
    expect(sent).toEqual([a, b].sort());
    expect(sent).not.toContain(c);
    expect(sent).not.toContain(d);

    // the same window again: nothing; two minutes later: the two are taken again
    expect(await kit.lifecycle.recoverStalled()).toEqual({ enqueued: 0 });
    kit.clock.advance(121_000);
    kit.enqueued.length = 0;
    const later = await kit.lifecycle.recoverStalled();
    expect(later.enqueued).toBeGreaterThanOrEqual(2);
    expect(
      kit.enqueued.map((m) => (m.body as { importId: string }).importId),
    ).toEqual(expect.arrayContaining([a, b, c]));
    // a recovered job is delivered like any other and never has two runners
    expect(await kit.deliver(a)).toBe('done');
  }, 60_000);

  it('S07 AS-41: the consumer takes only {importId}; malformed bodies never reach the handler, an unknown job is retried without side effect and logged with its message id', async () => {
    const queue = kit.app.get(TaskQueue);
    const consume = jest
      .spyOn(queue, 'consume')
      .mockReturnValue(async () => undefined);
    const consumer = kit.consumer();
    consumer.onApplicationBootstrap();
    const [name, handler, options] = consume.mock.calls[0] as unknown as [
      string,
      (m: {
        id: string;
        body: unknown;
        receiveCount: number;
        attributes: object;
      }) => Promise<void>,
      {
        bodySchema: typeof importMessageSchema;
        concurrency: number;
        visibilityTimeoutSec: number;
      },
    ];
    expect(name).toBe('catalog-imports');
    expect(options).toMatchObject({
      concurrency: 4,
      visibilityTimeoutSec: 300,
    });
    const bad: unknown[] = [
      'not json at all',
      {},
      { importId: 'not-a-uuid' },
      { importId: randomUUID(), kind: 'import' },
      { importId: randomUUID(), jobId: randomUUID() },
      { jobId: randomUUID() },
      [randomUUID()],
      null,
    ];
    for (const body of bad)
      expect(options.bodySchema.safeParse(body).success).toBe(false);
    expect(
      options.bodySchema.safeParse({ importId: randomUUID() }).success,
    ).toBe(true);

    // an unknown job: no side effect, and one structured line with the message id
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const reads = kit.probe.reads.length;
    const live = kit.rt.events.length;
    await expect(
      handler({
        id: 'msg-41',
        body: { importId: randomUUID() },
        receiveCount: 1,
        attributes: {},
      }),
    ).rejects.toThrow();
    expect(kit.probe.reads.length).toBe(reads);
    expect(kit.rt.events.length).toBe(live);
    expect(kit.enqueued).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).toContain('msg-41');
  });

  it('S07 AS-42: a CSV that breaks after 700 rows ends malformed_file at the broken record; the stream is destroyed, the first batch stays, the refused rows so far are reported', async () => {
    const s = await seller();
    const head = catalogCsv(700, { bad: [100] }).toString('utf8');
    const tail = Array.from(
      { length: 50 },
      (_, i) => `SKU-${702 + i},T,"d",1.00,1,c,b`,
    ).join('\n');
    const file = Buffer.from(`${head}SKU-701,ti"tle,"d",1.00,1,c,b\n${tail}\n`);
    const id = await kit.uploaded(s, file);
    expect(await kit.deliver(id)).toBe('failed');
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'FAILED',
      failureCode: 'malformed_file',
      rowsProcessed: 500,
      lastRow: 500,
      rowsFailed: 1,
    });
    expect(job.failureDetail).toContain('701');
    expect(kit.probe.sources().at(-1)!.stream.destroyed).toBe(true);
    expect((await kit.productsOf(s.shop.id)).size).toBe(499);
    const report = (await kit.objectText(job.errorReportKey!))
      .trim()
      .split('\n');
    expect(report[0]).toBe('row,sku,field,code,message');
    expect(
      report.slice(1).map((l) => l.split(',').slice(0, 4).join(',')),
    ).toEqual([
      '100,SKU-100,title,missing_required',
      '100,SKU-100,price,invalid_price',
      '100,SKU-100,stock,invalid_stock',
    ]);
  });

  it('S07 AS-44: a transient database fault on a checkpoint is retried by redelivery and ends DONE with exact counters', async () => {
    const s = await seller();
    const file = catalogCsv(2000);
    const id = await kit.uploaded(s, file);
    await installFault(1000);
    await expect(kit.deliver(id, 1)).rejects.toThrow();
    expect(await kit.job(id)).toMatchObject({
      status: 'PROCESSING',
      lastRow: 500,
      leaseHolder: null,
    });
    await dropFault();
    expect(await kit.deliver(id, 2)).toBe('done');
    const clean = await cleanRun(file);
    const job = await kit.job(id);
    expect(job.rowsProcessed).toBe(2000);
    expect(job.rowsFailed).toBe(0);
    expect(job.rowsCreated + job.rowsUnchanged).toBe(2000);
    expect(snapshot(await kit.productsOf(s.shop.id))).toEqual(
      snapshot(clean.products),
    );
  }, 60_000);

  it('S07 AS-44: a fault that lasts through the third delivery ends FAILED internal_error with a generic message, the checkpoint kept and the message left to the dead-letter queue', async () => {
    const s = await seller();
    const id = await kit.uploaded(s, catalogCsv(2000));
    await installFault(1000);
    await expect(kit.deliver(id, 1)).rejects.toThrow();
    await expect(kit.deliver(id, 2)).rejects.toThrow();
    await expect(kit.deliver(id, 3)).rejects.toThrow(); // recorded first, then failed so the queue dead-letters it
    await dropFault();
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'FAILED',
      failureCode: 'internal_error',
      lastRow: 500,
      rowsProcessed: 500,
    });
    const res = await kit
      .as(s.owner)
      .get(`/api/shops/${s.shop.id}/imports/${id}`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    for (const leak of ['statement', 'SQL', 'trigger', 'ImportJob', '57014'])
      expect(text).not.toContain(leak);
    expect(res.body.failure.code).toBe('internal_error');
    expect(await kit.finishedEvents(id)).toHaveLength(1);
  }, 60_000);

  it('S07 AS-45: a shop that is suspended before the run fails the import shop_not_active at once, without retry', async () => {
    const s = await seller();
    const id = await kit.uploaded(s, catalogCsv(50));
    await kit.setShopStatus(s.shop.id, 'SUSPENDED');
    expect(await kit.deliver(id)).toBe('failed');
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'FAILED',
      failureCode: 'shop_not_active',
      rowsProcessed: 0,
    });
    expect(await kit.exists(job.storageKey)).toBe(false);
    expect(kit.catalogCalls()).toEqual([]);
  });

  it('S07 AS-45: a shop that is suspended after batch 2 fails the import there: batch 3 is not written, the checkpoint stays at batch 2', async () => {
    const s = await seller();
    const file = catalogCsv(2000);
    const id = await kit.uploaded(s, file);
    const { running } = await holdAt(kit.newRunner(), id, file, 1000);
    await kit.setShopStatus(s.shop.id, 'SUSPENDED');
    kit.probe.release();
    expect(await running).toBe('failed');
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'FAILED',
      failureCode: 'shop_not_active',
      lastRow: 1000,
      rowsProcessed: 1000,
    });
    expect((await kit.productsOf(s.shop.id)).size).toBe(1000);
    expect(await kit.exists(job.storageKey)).toBe(false);
  }, 60_000);

  it('S07 AS-46: past the error cap the import stops at the batch that passed it; its failed rows are reported once and later rows are not read', async () => {
    const s = await seller();
    const rows = 40_000; // large against the 64 KiB storage chunks, so "not read ahead" is measurable
    const file = catalogCsv(rows, {
      bad: Array.from({ length: rows }, (_, i) => i + 1),
    });
    const id = await kit.uploaded(s, file);
    expect(await kit.deliver(id)).toBe('failed');
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'FAILED',
      failureCode: 'too_many_errors',
      rowsProcessed: 500,
      rowsFailed: 500,
      lastRow: 500,
    });
    const lines = (await kit.objectText(job.errorReportKey!))
      .trim()
      .split('\n')
      .slice(1);
    const perRow = new Map<string, number>();
    for (const line of lines)
      perRow.set(line.split(',')[0], (perRow.get(line.split(',')[0]) ?? 0) + 1);
    expect(perRow.size).toBe(500);
    expect([...perRow.values()].every((n) => n === 3)).toBe(true);
    expect(Math.max(...[...perRow.keys()].map(Number))).toBe(500);
    // the rest of the file was not read ahead
    expect(kit.probe.sources().at(-1)!.delivered()).toBeLessThan(
      file.length / 2,
    );
  }, 60_000);

  it('S07 AS-71: a source file that is gone fails the import source_missing at once: nothing is written, no retry, the event is produced', async () => {
    const s = await seller();
    const id = await kit.uploaded(s, catalogCsv(10));
    const { storageKey } = await kit.job(id);
    await kit.storage.delete(storageKey);
    expect(await kit.deliver(id)).toBe('failed');
    expect(await kit.job(id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'source_missing',
      rowsProcessed: 0,
    });
    expect(kit.catalogCalls()).toEqual([]);
    const events = await kit.finishedEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      status: 'FAILED',
      failureCode: 'source_missing',
    });
  });

  void DAY;
  void QueryTypes;
});
