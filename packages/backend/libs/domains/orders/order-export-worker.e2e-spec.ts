import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { orderExportSchema } from '@marketplace-sandbox/contracts';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  OrderExportConsumer,
  exportMessageSchema,
} from './infra/order-export.consumer';
import {
  DAY,
  MIN,
  T,
  createExportApp,
  csvRows,
  outboxRowsFor,
  seedBulkLines,
  startExport,
  waitFor,
  type ExportKit,
} from './testing/order-export.fixtures';

/** A latch a spec holds a run at (the run is "dead" or paused until the spec opens it). */
function latch() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe('Order export: failure, retry, cancel, crash and duplicate delivery', () => {
  let kit: ExportKit;
  /** The same app with a row limit of 10 and a one-second storage inactivity limit. */
  let tight: ExportKit;
  let db: Sequelize;
  const shops: string[] = [];

  beforeAll(async () => {
    kit = await createExportApp();
    tight = await createExportApp({
      env: {
        ORDER_EXPORT_ROW_LIMIT: '10',
        ORDER_EXPORT_STORAGE_INACTIVITY_SEC: '1',
      },
    });
    db = kit.app.get(Sequelize);
  });
  afterAll(async () => {
    await kit.forget(shops);
    await kit.close();
    await tight.close();
  });
  beforeEach(async () => {
    await kit.reset();
    await tight.reset();
  });
  /** Spies a spec installs; restored one by one (the kit's own spies must survive from test to test). */
  const spies: jest.SpyInstance[] = [];
  const spy = <S extends jest.SpyInstance>(s: S): S => {
    spies.push(s);
    return s;
  };
  afterEach(async () => {
    for (const s of spies.splice(0)) s.mockRestore();
    await kit.forget(shops.splice(0)); // L-013: a fault test leaves nothing behind
  });

  type Seller = Awaited<ReturnType<typeof seller>>;
  /** A shop with an owner and `lines` order lines (100 per order). */
  const seller = async (app: ExportKit, lines: number) => {
    const owner = await app.newUser();
    const shop = await createShop(app.app, owner);
    shops.push(shop.id);
    const product = await createProduct(app.app, shop, {
      externalSku: 'SKU-W',
    });
    if (lines > 0)
      await seedBulkLines(app.app, {
        shopId: shop.id,
        productId: product.id,
        buyerId: owner.id,
        orders: Math.ceil(lines / (lines >= 100 ? 100 : 1)),
        perOrder: lines >= 100 ? 100 : 1,
        at: new Date(T.getTime() - DAY),
      });
    return { owner, shop, product, app };
  };
  const begin = async (s: Seller) => {
    const res = await startExport(s.app, s.owner, s.shop.id);
    expect(res.status).toBe(202);
    return res.body.exportId as string;
  };
  const objects = (s: Seller) =>
    s.app.app.get(ObjectStorage).list(`exports/${s.shop.id}/`);
  const history = (exportId: string) =>
    db.query<{
      fromStatus: string | null;
      toStatus: string;
      reason: string | null;
      actor: string | null;
    }>(
      `SELECT "fromStatus", "toStatus", "reason", "actor" FROM "ExportJobHistory" WHERE "exportId" = :exportId ORDER BY "at", "id"`,
      { type: QueryTypes.SELECT, replacements: { exportId } },
    );
  const finished = async (exportId: string) =>
    (await outboxRowsFor(db, exportId)).filter(
      (o) => o.type === 'orderexport.finished',
    );
  const sent = (app: ExportKit) =>
    app.enqueued.filter((m) => m.queue === 'order-exports');
  const cancelPath = (s: Seller, id: string) =>
    `/api/shops/${s.shop.id}/order-exports/${id}/cancel`;
  const typesOf = (app: ExportKit, id: string) =>
    app.rt.of(id).map((e) => e.type);
  /** Claims an export the way a worker does, without running it. */
  const claim = (id: string, leaseSeconds = 300) =>
    kit.jobs.claim({
      exportId: id,
      leaseHolder: randomUUID(),
      leaseExpiresAt: new Date(kit.clock.now().getTime() + leaseSeconds * 1000),
      now: kit.clock.now(),
    });

  describe('transient failure, retry and final failure (AS-33, AS-34, AS-36, AS-37, AS-38)', () => {
    it('S12 AS-33: storage failing once after 3,000 lines aborts the upload, returns the export to QUEUED with a delayed redelivery and no event; the second delivery completes it with every line once', async () => {
      const s = await seller(kit, 5_000);
      const id = await begin(s);
      kit.storageControl.failAfter(450_000, { once: true });

      expect(await kit.run.handle(id)).toBe('retry');

      expect(await kit.jobs.findById(id)).toMatchObject({
        status: 'QUEUED',
        attempt: 1,
        rowsWritten: 0,
        bytesWritten: 0,
        totalRows: null,
        failureCode: null,
      });
      expect(await objects(s)).toEqual([]);
      expect(
        (await history(id)).map((h) => [h.fromStatus, h.toStatus, h.reason]),
      ).toEqual([
        [null, 'QUEUED', null],
        ['QUEUED', 'RUNNING', null],
        ['RUNNING', 'QUEUED', 'retry'],
      ]);
      const retry = sent(kit).at(-1)!;
      expect(sent(kit)).toHaveLength(2);
      const delay = (retry.options as { delaySeconds: number }).delaySeconds;
      expect(delay).toBeGreaterThanOrEqual(48);
      expect(delay).toBeLessThanOrEqual(72);
      expect(typesOf(kit, id)).not.toContain('failed');
      expect(typesOf(kit, id)).not.toContain('done');
      expect(await finished(id)).toHaveLength(0);

      expect(await kit.run.handle(id)).toBe('done');

      expect(await kit.jobs.findById(id)).toMatchObject({
        status: 'DONE',
        attempt: 2,
        rowsWritten: 5_000,
        totalRows: 5_000,
      });
      const rows = csvRows(await kit.fileOf(id));
      expect(rows).toHaveLength(5_000);
      expect(new Set(rows.map((r) => r.split(',')[7])).size).toBe(5_000);
      expect(await finished(id)).toHaveLength(1);
      expect(typesOf(kit, id).filter((t) => t === 'done')).toHaveLength(1);
    });

    it('S12 AS-34: three failing attempts end FAILED storage_unavailable with the generic message, no file and one failed event; a new export may start', async () => {
      const s = await seller(kit, 5_000);
      const id = await begin(s);
      kit.storageControl.failAfter(450_000);

      expect(await kit.run.handle(id)).toBe('retry');
      expect(await kit.run.handle(id)).toBe('retry');
      expect(await kit.run.handle(id)).toBe('failed');

      const read = await kit
        .as(s.owner)
        .get(`/api/shops/${s.shop.id}/order-exports/${id}`);
      expect(orderExportSchema.parse(read.body)).toMatchObject({
        status: 'FAILED',
        attempt: 3,
        failure: {
          code: 'storage_unavailable',
          message: 'The file could not be stored. Start a new export.',
        },
      });
      expect(await objects(s)).toEqual([]);
      expect(kit.rt.of(id).filter((e) => e.type === 'failed')).toEqual([
        expect.objectContaining({
          data: { code: 'storage_unavailable' },
          replay: true,
        }),
      ]);
      const events = await finished(id);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        payload: {
          status: 'FAILED',
          failureCode: 'storage_unavailable',
          attempt: 3,
        },
      });
      expect(sent(kit)).toHaveLength(3); // the start and two retries; the third failure is final

      kit.storageControl.reset();
      expect((await startExport(kit, s.owner, s.shop.id)).status).toBe(202);
    });

    it('S12 AS-36: an export over the row limit fails at once as row_limit_exceeded, writes nothing and is not retried', async () => {
      const s = await seller(tight, 11);
      const id = await begin(s);

      expect(await tight.run.handle(id)).toBe('failed');

      expect(await tight.jobs.findById(id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'row_limit_exceeded',
        totalRows: 11,
        rowsWritten: 0,
      });
      expect(await objects(s)).toEqual([]);
      expect(sent(tight)).toHaveLength(1);
      await tight.forget([s.shop.id]);
    });

    it('S12 AS-37: a run past its deadline fails as timeout at the next batch, with no retry and no file', async () => {
      const s = await seller(kit, 2_500);
      const id = await begin(s);
      kit.storageControl.hold();
      kit.resetLinesRead();

      const running = kit.run.handle(id);
      await waitFor('the first batch was read', () => kit.linesRead() >= 1000);
      for (let minute = 0; minute < 121; minute++) {
        kit.clock.advance(MIN);
        await kit.run.heartbeatTick(); // the lease is extended every minute, as the real heartbeat does
      }
      kit.storageControl.release();

      expect(await running).toBe('failed');
      expect(await kit.jobs.findById(id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'timeout',
      });
      expect(await objects(s)).toEqual([]);
      expect(sent(kit)).toHaveLength(1);
    });

    it('S12 AS-38: storage that stops taking bytes for longer than the inactivity limit aborts the upload and takes the transient path', async () => {
      const s = await seller(tight, 5); // the tight app's row limit is 10
      const id = await begin(s);
      tight.storageControl.stallAfter(0);

      expect(await tight.run.handle(id)).toBe('retry');

      expect(await tight.jobs.findById(id)).toMatchObject({
        status: 'QUEUED',
        attempt: 1,
      });
      expect(await objects(s)).toEqual([]);
      expect(sent(tight)).toHaveLength(2);
      expect((await history(id)).at(-1)).toMatchObject({
        toStatus: 'QUEUED',
        reason: 'retry',
      });
      await tight.forget([s.shop.id]);
    });
  });

  describe('cancel (AS-39, AS-40, AS-41, AS-42)', () => {
    it('S12 AS-39: cancelling a queued export ends it CANCELLED with the actor in the history and one event; its later message does nothing', async () => {
      const s = await seller(kit, 100);
      const id = await begin(s);

      const res = await kit.as(s.owner).post(cancelPath(s, id)).send();

      expect(res.status).toBe(200);
      expect(orderExportSchema.parse(res.body).status).toBe('CANCELLED');
      expect((await history(id)).at(-1)).toMatchObject({
        fromStatus: 'QUEUED',
        toStatus: 'CANCELLED',
        actor: s.owner.id,
      });
      expect(await finished(id)).toHaveLength(1);
      expect(kit.rt.of(id).filter((e) => e.type === 'cancelled')).toHaveLength(
        1,
      );

      expect(await kit.run.handle(id)).toBe('ignored');

      expect((await kit.jobs.findById(id))!.status).toBe('CANCELLED');
      expect(await objects(s)).toEqual([]);
      expect(typesOf(kit, id)).not.toContain('done');
    });

    it('S12 AS-40: cancelling a running export stops it at the next batch, aborts the upload, publishes cancelled once and never done', async () => {
      const s = await seller(kit, 3_500);
      const id = await begin(s);
      const hold = latch();
      kit.hooks.onLookup = async () => {
        if (kit.skuCalls.length === 3) await hold.promise;
      };

      const running = kit.run.handle(id);
      await waitFor(
        'the third batch is being read',
        () => kit.skuCalls.length >= 3,
      );
      const before = await kit.jobs.findById(id);
      const res = await kit.as(s.owner).post(cancelPath(s, id)).send();
      expect(res.status).toBe(200);
      hold.open();

      expect(await running).toBe('cancelled');

      const after = await kit.jobs.findById(id);
      expect(after).toMatchObject({
        status: 'CANCELLED',
        rowsWritten: before!.rowsWritten,
      });
      expect(await objects(s)).toEqual([]);
      expect(typesOf(kit, id).filter((t) => t === 'cancelled')).toHaveLength(1);
      expect(typesOf(kit, id)).not.toContain('done');
      expect(kit.skuCalls.length).toBeLessThanOrEqual(4); // it stopped; it did not read the remaining batches
    });

    it('S12 AS-41: cancelling twice is 200 unchanged with one history row; a finished export is 409 export_not_cancellable; two cancels at once make one event', async () => {
      const s = await seller(kit, 100);
      const id = await begin(s);
      const first = await kit.as(s.owner).post(cancelPath(s, id)).send();
      const second = await kit.as(s.owner).post(cancelPath(s, id)).send();
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.body).toEqual(first.body);
      expect(
        (await history(id)).filter((h) => h.toStatus === 'CANCELLED'),
      ).toHaveLength(1);
      expect(await finished(id)).toHaveLength(1);

      // DONE, FAILED and EXPIRED
      const done = await begin(s);
      await kit.run.handle(done);
      const failed = await (async () => {
        const e = await begin(s);
        const claimed = await claim(e);
        await kit.jobs.finish({
          exportId: e,
          leaseHolder: claimed!.leaseHolder!,
          to: 'FAILED',
          failureCode: 'internal_error',
          rowsWritten: 0,
          bytesWritten: 0,
          now: kit.clock.now(),
        });
        return e;
      })();
      const expired = await begin(s);
      await kit.run.handle(expired);
      await kit.jobs.markExpired(expired, kit.clock.now());
      for (const e of [done, failed, expired]) {
        const res = await kit.as(s.owner).post(cancelPath(s, e)).send();
        expect([res.status, res.body.code]).toEqual([
          409,
          'export_not_cancellable',
        ]);
      }

      // two cancels at the same instant
      const racing = await begin(s);
      const [a, b] = await Promise.all([
        kit.as(s.owner).post(cancelPath(s, racing)).send(),
        kit.as(s.owner).post(cancelPath(s, racing)).send(),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(
        (await history(racing)).filter((h) => h.toStatus === 'CANCELLED'),
      ).toHaveLength(1);
      expect(await finished(racing)).toHaveLength(1);
      expect(
        kit.rt.of(racing).filter((e) => e.type === 'cancelled'),
      ).toHaveLength(1);
    });

    it('S12 AS-42: cancel and completion racing leave one winner in both orders', async () => {
      const s = await seller(kit, 100);

      // completion first, then cancel
      const done = await begin(s);
      await kit.run.handle(done);
      const late = await kit.as(s.owner).post(cancelPath(s, done)).send();
      expect([late.status, late.body.code]).toEqual([
        409,
        'export_not_cancellable',
      ]);
      expect((await kit.jobs.findById(done))!.status).toBe('DONE');

      // cancel lands right before the completing commit
      const raced = await begin(s);
      const realFinish = kit.jobs.finish.bind(kit.jobs);
      spy(jest.spyOn(kit.jobs, 'finish')).mockImplementation(async (input) => {
        if (input.to === 'DONE')
          expect(
            (await kit.as(s.owner).post(cancelPath(s, raced)).send()).status,
          ).toBe(200);
        return realFinish(input);
      });

      expect(await kit.run.handle(raced)).toBe('cancelled');

      expect((await kit.jobs.findById(raced))!.status).toBe('CANCELLED');
      expect(await objects(s)).toHaveLength(1); // only the finished export's file; the cancelled attempt's object is gone
      expect(typesOf(kit, raced)).not.toContain('done');
      expect(await finished(raced)).toHaveLength(1);
    });
  });

  describe('messages, duplicate delivery and the consumer (AS-43, AS-44)', () => {
    it('S12 AS-43: two workers given the same message make one claim, one file, one DONE and one event', async () => {
      const s = await seller(kit, 2_500);
      const id = await begin(s);

      const outcomes = await Promise.all([
        kit.run.handle(id),
        kit.run.handle(id),
      ]);

      expect([...outcomes].sort()).toEqual(['done', 'ignored']);
      expect(await kit.jobs.findById(id)).toMatchObject({
        status: 'DONE',
        attempt: 1,
      });
      expect(await objects(s)).toHaveLength(1);
      expect(await finished(id)).toHaveLength(1);
      expect(typesOf(kit, id).filter((t) => t === 'done')).toHaveLength(1);
    });

    it('S12 AS-44: finished and running exports are acknowledged without effect, an unknown id with one warning, and only {exportId} is a valid message', async () => {
      const s = await seller(kit, 100);
      const doneId = await begin(s);
      await kit.run.handle(doneId);
      const cancelled = await begin(s);
      await kit.as(s.owner).post(cancelPath(s, cancelled)).send();
      const running = await begin(s);
      await claim(running);
      const states = [doneId, cancelled, running];
      const before = await Promise.all(states.map((e) => kit.jobs.findById(e)));

      for (const e of states) expect(await kit.run.handle(e)).toBe('ignored');
      expect(
        await Promise.all(states.map((e) => kit.jobs.findById(e))),
      ).toEqual(before);

      const warn = spy(jest.spyOn(Logger.prototype, 'warn'));
      expect(await kit.run.handle(randomUUID())).toBe('unknown');
      const warnings = warn.mock.calls.filter(([m]) =>
        String(m).startsWith('order_export_message_for_unknown_export'),
      );
      expect(warnings).toHaveLength(1);

      const invalid: unknown[] = [
        {},
        { exportId: 'not-a-uuid' },
        { exportId: randomUUID(), extra: true },
        { kind: 'export', jobId: randomUUID() }, // the old import-queue shape
      ];
      for (const body of invalid)
        expect(exportMessageSchema.safeParse(body).success).toBe(false);
      expect(
        exportMessageSchema.safeParse({ exportId: randomUUID() }).success,
      ).toBe(true);

      // the consumer registers exactly that schema on the export queue and hands valid messages to the run
      const registered: Array<{
        queue: string;
        options: { bodySchema?: unknown };
      }> = [];
      let handler:
        ((m: { body: { exportId: string } }) => Promise<void>) | undefined;
      const fakeQueue = {
        consume: (
          queue: string,
          h: typeof handler,
          options: { bodySchema?: unknown },
        ) => {
          registered.push({ queue, options });
          handler = h;
          return () => Promise.resolve();
        },
        queueExists: () => Promise.resolve(true),
      } as unknown as TaskQueue;
      const consumer = new OrderExportConsumer(fakeQueue, kit.run);
      consumer.onApplicationBootstrap();
      expect(registered).toHaveLength(1);
      expect(registered[0].queue).toBe('order-exports');
      expect(registered[0].options.bodySchema).toBe(exportMessageSchema);
      const handle = spy(jest.spyOn(kit.run, 'handle')).mockResolvedValue(
        'ignored',
      );
      const exportId = randomUUID();
      await handler!({ body: { exportId } });
      expect(handle).toHaveBeenCalledWith(exportId);
    });
  });

  describe('crash recovery, lease and fencing (AS-45 to AS-50)', () => {
    /** Holds the n-th catalog lookup (counting from now) until opened: the run is "dead" or paused there. */
    const holdAtLookup = (n: number) => {
      const gate = latch();
      const from = kit.skuCalls.length;
      const previous = kit.hooks.onLookup;
      kit.hooks.onLookup = async () => {
        await previous?.();
        if (kit.skuCalls.length === from + n) await gate.promise;
      };
      return gate;
    };

    it('S12 AS-45: a worker killed at batch 7 is recovered once by two instances, and the final file equals that of an uninterrupted run', async () => {
      const s = await seller(kit, 8_000);
      const reference = await begin(s);
      await kit.run.handle(reference);
      const expected = await kit.fileOf(reference);

      const id = await begin(s);
      const dead = holdAtLookup(7);
      const crashed = kit.run.handle(id);
      await waitFor('batch 7', () => kit.skuCalls.length >= 7 + 8);
      expect(await objects(s)).toHaveLength(1); // only the reference export's file; nothing partial is visible
      const early = await kit
        .as(s.owner)
        .get(`/api/shops/${s.shop.id}/order-exports/${id}/download`);
      expect(early.status).toBe(409);

      kit.clock.advance(6 * MIN);
      const [a, b] = await Promise.all([
        kit.maintenance.recoverStalled(),
        kit.maintenance.recoverStalled(),
      ]);

      expect(a.requeued + b.requeued).toBe(1);
      expect((await kit.jobs.findById(id))!.status).toBe('QUEUED');
      expect(
        (await history(id)).filter((h) => h.reason === 'lease_expired'),
      ).toHaveLength(1);
      expect(
        sent(kit).filter(
          (m) => (m.body as { exportId: string }).exportId === id,
        ),
      ).toHaveLength(2);

      expect(await kit.run.handle(id)).toBe('done');
      dead.open();
      expect(await crashed).toBe('lost');

      expect(await kit.fileOf(id)).toBe(expected);
      expect(await objects(s)).toHaveLength(2); // the reference file and this export's file
      expect(await finished(id)).toHaveLength(1);
    });

    it('S12 AS-46: a queued export that no worker took for over two minutes gets its message once more; a younger one is left alone', async () => {
      const old = await seller(kit, 100);
      const young = await seller(kit, 100);
      const oldId = await begin(old);
      kit.clock.advance(3 * MIN);
      const youngId = await begin(young);
      const before = sent(kit).length;

      const first = await kit.maintenance.recoverStalled();
      const again = await kit.maintenance.recoverStalled();

      expect(first.resent).toBe(1);
      expect(again.resent).toBe(0);
      const resent = sent(kit).slice(before);
      expect(
        resent.map((m) => (m.body as { exportId: string }).exportId),
      ).toEqual([oldId]);
      expect((await kit.jobs.findById(youngId))!.status).toBe('QUEUED');
    });

    it('S12 AS-47: a running export whose lease lapsed at the third attempt ends FAILED attempts_exhausted without a new message', async () => {
      const s = await seller(kit, 100);
      const id = await begin(s);
      await claim(id);
      await db.query(`UPDATE "ExportJob" SET "attempt" = 3 WHERE "id" = :id`, {
        replacements: { id },
      });
      kit.clock.advance(6 * MIN);
      const before = sent(kit).length;

      const result = await kit.maintenance.recoverStalled();

      expect(result.failed).toBe(1);
      expect(await kit.jobs.findById(id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'attempts_exhausted',
      });
      expect(sent(kit)).toHaveLength(before);
      expect(await finished(id)).toHaveLength(1);
      expect(kit.rt.of(id).filter((e) => e.type === 'failed')).toEqual([
        expect.objectContaining({ data: { code: 'attempts_exhausted' } }),
      ]);
    });

    it('S12 AS-48: a shutdown during a run puts the export back to QUEUED without costing an attempt, and the redelivery completes it', async () => {
      const s = await seller(kit, 2_500);
      const id = await begin(s);
      kit.storageControl.hold();
      kit.resetLinesRead();
      const running = kit.run.handle(id);
      await waitFor('the first batch was read', () => kit.linesRead() >= 1000);

      kit.run.shutdown();

      expect(await running).toBe('shutdown');
      expect(await kit.jobs.findById(id)).toMatchObject({
        status: 'QUEUED',
        attempt: 0,
        rowsWritten: 0,
      });
      expect((await history(id)).at(-1)).toMatchObject({
        toStatus: 'QUEUED',
        reason: 'shutdown',
      });
      expect(sent(kit)).toHaveLength(2);
      expect(await objects(s)).toEqual([]);

      kit.storageControl.reset();
      expect(await kit.run.handle(id)).toBe('done');
      expect(await kit.jobs.findById(id)).toMatchObject({
        status: 'DONE',
        attempt: 1,
      });
    });

    it('S12 AS-49: thirty minutes of heartbeats keep a long run alive while recovery runs every minute and changes nothing', async () => {
      const s = await seller(kit, 2_500);
      const id = await begin(s);
      kit.storageControl.hold();
      kit.resetLinesRead();
      const running = kit.run.handle(id);
      await waitFor('the first batch was read', () => kit.linesRead() >= 1000);
      const holder = (await kit.jobs.findById(id))!.leaseHolder;
      const sentBefore = sent(kit).length;
      const historyBefore = (await history(id)).length;

      for (let minute = 0; minute < 30; minute++) {
        kit.clock.advance(MIN);
        await kit.run.heartbeatTick();
        const recovered = await kit.maintenance.recoverStalled();
        expect(recovered).toEqual({ requeued: 0, failed: 0, resent: 0 });
      }

      expect(await kit.jobs.findById(id)).toMatchObject({
        status: 'RUNNING',
        leaseHolder: holder,
      });
      expect(sent(kit)).toHaveLength(sentBefore);
      expect(await history(id)).toHaveLength(historyBefore);
      kit.storageControl.release();
      expect(await running).toBe('done');
    });

    it('S12 AS-50: a worker that lost its lease changes nothing: its progress, counters, completion and file are fenced out', async () => {
      const s = await seller(kit, 4_000);
      const id = await begin(s);
      const lostGate = holdAtLookup(2); // worker A pauses at its second batch
      const a = kit.run.handle(id);
      await waitFor('A is at its second batch', () => kit.skuCalls.length >= 2);
      kit.clock.advance(6 * MIN);
      expect((await kit.maintenance.recoverStalled()).requeued).toBe(1);

      const bGate = latch();
      const callsBefore = kit.skuCalls.length;
      kit.hooks.onLookup = async () => {
        if (kit.skuCalls.length === callsBefore + 2) await bGate.promise; // B pauses at its second batch
      };
      const b = kit.run.handle(id);
      await waitFor(
        'B is at its second batch',
        () => kit.skuCalls.length >= callsBefore + 2,
      );
      const holderB = (await kit.jobs.findById(id))!.leaseHolder;
      const mid = await kit.jobs.findById(id);

      lostGate.open(); // A wakes up, its lease is long gone
      expect(await a).toBe('lost');

      expect(await kit.jobs.findById(id)).toMatchObject({
        status: 'RUNNING',
        leaseHolder: holderB,
        rowsWritten: mid!.rowsWritten,
        attempt: mid!.attempt,
      });
      bGate.open();
      expect(await b).toBe('done');
      const job = await kit.jobs.findById(id);
      expect(job).toMatchObject({ status: 'DONE', rowsWritten: 4_000 });
      expect(csvRows(await kit.fileOf(id))).toHaveLength(4_000);
      expect(await objects(s)).toHaveLength(1);
      expect((await history(id)).map((h) => h.toStatus)).toEqual([
        'QUEUED',
        'RUNNING',
        'QUEUED',
        'RUNNING',
        'DONE',
      ]);
      expect(await finished(id)).toHaveLength(1);
    });
  });
});
