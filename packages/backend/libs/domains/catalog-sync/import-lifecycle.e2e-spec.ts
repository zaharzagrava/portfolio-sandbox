import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import {
  importEventSchemas,
  importStartResponseSchema,
} from '@marketplace-sandbox/contracts';
import {
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
} from '@app/domains/tenancy';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { PermanentError } from '@app/infrastructure/projections/errors';
import {
  DAY,
  catalogCsv,
  createImportApp,
  type ImportKit,
  type Seller,
} from './testing/import-kit';

describe('Bulk import lifecycle and events', () => {
  let kit: ImportKit;
  const shops: string[] = [];

  beforeAll(async () => {
    kit = await createImportApp();
  });
  afterAll(async () => {
    await dropOutboxFault();
    await kit.forget(shops);
    await kit.close();
  });
  beforeEach(async () => {
    await dropOutboxFault();
    await kit.reset();
  });
  afterEach(async () => {
    await dropOutboxFault();
    kit.probe.release();
    await kit.forget(shops.splice(0));
  });

  const seller = async (): Promise<Seller> => {
    const s = await kit.seller();
    shops.push(s.shop.id);
    return s;
  };
  const base = (s: { shop: { id: string } }) =>
    `/api/shops/${s.shop.id}/imports`;
  /** A real database fault (L-013: dropped after every test): the outbox insert of this aggregate fails. */
  const installOutboxFault = (importId: string) =>
    kit.db.query(`
      CREATE OR REPLACE FUNCTION import_test_outbox_fault() RETURNS trigger AS $$
      BEGIN
        IF NEW."aggregateId"::text = '${importId}' THEN
          RAISE EXCEPTION 'outbox is unavailable' USING ERRCODE = '53100';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS import_test_outbox_fault ON "Outbox";
      CREATE TRIGGER import_test_outbox_fault BEFORE INSERT ON "Outbox"
        FOR EACH ROW EXECUTE FUNCTION import_test_outbox_fault();`);
  function dropOutboxFault() {
    return kit?.db
      ? kit.db.query(
          `DROP TRIGGER IF EXISTS import_test_outbox_fault ON "Outbox"`,
        )
      : Promise.resolve();
  }
  const count = async (
    table: 'ImportJob' | 'ImportJobHistory',
    where: string,
    ids: string[],
  ) =>
    Number(
      (
        await kit.db.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM "${table}" WHERE "${where}" IN (:ids)`,
          { replacements: { ids }, type: QueryTypes.SELECT },
        )
      )[0].n,
    );
  const age = (id: string, days: number) =>
    kit.db.query(`UPDATE "ImportJob" SET "finishedAt" = :at WHERE "id" = :id`, {
      replacements: {
        id,
        at: new Date(kit.clock.now().getTime() - days * DAY),
      },
    });
  const offboarding = (shopId: string) =>
    ShopOffboardingStarted.create(shopId, 3, {
      shopId,
      purgeAt: kit.clock.now().toISOString(),
      shopVersion: 3,
    });
  const deletedEvent = (shopId: string) =>
    ShopDeleted.create(shopId, 5, { shopId, shopVersion: 5 });

  it('S07 AS-64: a final job writes exactly one schema-valid import_finished row in its own transaction; a redelivery adds none; a failing outbox rolls the status back', async () => {
    const s = await seller();
    const id = await kit.uploaded(s, catalogCsv(5));
    await installOutboxFault(id);
    await expect(kit.deliver(id, 1)).rejects.toThrow();
    // the status change and its event are one transaction: neither happened
    expect(await kit.job(id)).toMatchObject({
      status: 'PROCESSING',
      rowsProcessed: 5,
    });
    expect(await kit.finishedEvents(id)).toEqual([]);
    expect((await kit.history(id)).some((h) => h.toStatus === 'DONE')).toBe(
      false,
    );
    await dropOutboxFault();

    expect(await kit.deliver(id, 2)).toBe('done');
    const events = await kit.finishedEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('catalogsync.import_finished');
    const payload = importEventSchemas['catalogsync.import_finished'].parse(
      events[0].payload,
    );
    expect(payload).toMatchObject({
      importId: id,
      shopId: s.shop.id,
      createdBy: s.owner.id,
      status: 'DONE',
      failureCode: null,
      rowsProcessed: 5,
      rowsCreated: 5,
    });
    expect(await kit.deliver(id, 3)).toBe('final');
    expect(await kit.finishedEvents(id)).toHaveLength(1);

    // every other way to end writes its own single row, and a repeated cancel adds nothing
    const failed = await kit.uploaded(s, Buffer.from('sku,title\nA,B\n'));
    await kit.deliver(failed);
    const cancelled = await kit.uploaded(s, catalogCsv(3, { prefix: 'C' }));
    expect(
      (await kit.as(s.owner).post(`${base(s)}/${cancelled}/cancel`)).status,
    ).toBe(200);
    expect(
      (await kit.as(s.owner).post(`${base(s)}/${cancelled}/cancel`)).status,
    ).toBe(200);
    for (const [jobId, status] of [
      [failed, 'FAILED'],
      [cancelled, 'CANCELLED'],
    ] as const) {
      const rows = await kit.finishedEvents(jobId);
      expect(rows).toHaveLength(1);
      expect(
        importEventSchemas['catalogsync.import_finished'].parse(rows[0].payload)
          .status,
      ).toBe(status);
    }
  }, 60_000);

  it("S07 AS-65: offboarding cancels the shop's non-final imports only; a repeat, a bad payload and offboarding_cancelled change nothing", async () => {
    const s = await seller();
    const other = await seller();
    const done = await kit.uploaded(s, catalogCsv(4));
    await kit.deliver(done);
    const waiting = await kit.uploaded(s, catalogCsv(4, { prefix: 'W' }));
    const pending = importStartResponseSchema.parse(
      (
        await kit
          .as(s.owner)
          .post(base(s))
          .set('Idempotency-Key', `key-${randomUUID()}`)
          .send({ fileName: 'a.csv', sizeBytes: 100 })
      ).body,
    ).importId;
    const foreign = await kit.uploaded(other, catalogCsv(4, { prefix: 'F' }));
    const doneBefore = await kit.job(done);

    await kit.offboarding.project([offboarding(s.shop.id)]);
    expect((await kit.job(waiting)).status).toBe('CANCELLED');
    expect((await kit.job(pending)).status).toBe('CANCELLED');
    expect(await kit.job(done)).toEqual(doneBefore);
    expect((await kit.job(foreign)).status).toBe('UPLOADED');
    expect(await kit.finishedEvents(waiting)).toHaveLength(1);

    const history = await kit.history(waiting);
    await kit.offboarding.project([offboarding(s.shop.id)]); // the same envelope again
    expect(await kit.history(waiting)).toEqual(history);
    expect(await kit.finishedEvents(waiting)).toHaveLength(1);

    for (const payload of [
      {},
      { shopId: 'not-a-uuid' },
      { shopId: randomUUID(), purgeAt: 5 },
    ]) {
      const bad = { ...offboarding(foreign), payload } as unknown as ReturnType<
        typeof offboarding
      >;
      await expect(kit.offboarding.project([bad])).rejects.toBeInstanceOf(
        PermanentError,
      );
    }
    expect((await kit.job(foreign)).status).toBe('UPLOADED');

    await kit.offboarding.project([
      ShopOffboardingCancelled.create(other.shop.id, 4, {
        shopId: other.shop.id,
        shopVersion: 4,
      }),
    ]);
    expect((await kit.job(foreign)).status).toBe('UPLOADED');
    expect((await kit.job(waiting)).status).toBe('CANCELLED'); // nobody is brought back
  }, 60_000);

  it("S07 AS-66: shop deletion removes the shop's rows, history and objects and nothing of others; repeats are safe and a storage failure is retried", async () => {
    const s = await seller();
    const other = await seller();
    const done = await kit.uploaded(s, catalogCsv(10, { bad: [2] }));
    await kit.deliver(done);
    const leftover = await kit.uploaded(s, catalogCsv(3, { prefix: 'L' }));
    const kept = await kit.uploaded(other, catalogCsv(3, { prefix: 'K' }));
    const report = (await kit.job(done)).errorReportKey!;
    const leftoverKey = (await kit.job(leftover)).storageKey;
    const keptKey = (await kit.job(kept)).storageKey;
    expect(await kit.exists(report)).toBe(true);

    const failing = jest
      .spyOn(kit.importStorage, 'deletePrefix')
      .mockRejectedValueOnce(new Error('storage is down'));
    await expect(
      kit.deleted.project([deletedEvent(s.shop.id)]),
    ).rejects.toThrow('storage is down');
    failing.mockRestore();
    expect(await count('ImportJob', 'id', [done, leftover])).toBe(2); // objects go before rows: nothing is half-gone

    await kit.deleted.project([deletedEvent(s.shop.id)]);
    expect(await count('ImportJob', 'id', [done, leftover])).toBe(0);
    expect(await count('ImportJobHistory', 'importId', [done, leftover])).toBe(
      0,
    );
    expect(await kit.exists(report)).toBe(false);
    expect(await kit.exists(leftoverKey)).toBe(false);
    expect(await count('ImportJob', 'id', [kept])).toBe(1);
    expect(await kit.exists(keptKey)).toBe(true);

    // again, and out of order with the offboarding event: nothing fails, nothing else changes
    await kit.deleted.project([deletedEvent(s.shop.id)]);
    await kit.offboarding.project([offboarding(s.shop.id)]);
    expect(await count('ImportJob', 'id', [kept])).toBe(1);
    await expect(
      kit.deleted.project([
        { ...deletedEvent(s.shop.id), payload: { shopId: 'x' } } as ReturnType<
          typeof deletedEvent
        >,
      ]),
    ).rejects.toBeInstanceOf(PermanentError);
  }, 60_000);

  it('S07 AS-67: reports go after 30 days, records after 90, final jobs only, at most 500 per run, oldest first, idempotent on one instance or two', async () => {
    const s = await seller();
    const make = async (prefix: string) => {
      const id = await kit.uploaded(s, catalogCsv(6, { prefix, bad: [3] }));
      await kit.deliver(id);
      return id;
    };
    const d31 = await make('A');
    const d91 = await make('B');
    const d10 = await make('C');
    const old = await kit.uploaded(s, catalogCsv(3, { prefix: 'D' }), {
      createdAt: new Date(kit.clock.now().getTime() - 100 * DAY),
    });
    await age(d31, 31);
    await age(d91, 91);
    await age(d10, 10);
    const key31 = (await kit.job(d31)).errorReportKey!;
    const key91 = (await kit.job(d91)).errorReportKey!;
    const key10 = (await kit.job(d10)).errorReportKey!;

    const runs = await Promise.all([
      kit.lifecycle.purge(),
      kit.lifecycle.purge(),
    ]);
    expect(runs.reduce((n, r) => n + r.records, 0)).toBe(1);
    expect(runs.reduce((n, r) => n + r.reports, 0)).toBe(1);
    const j31 = await kit.job(d31);
    expect(j31.errorReportKey).toBeNull();
    expect(await kit.exists(key31)).toBe(false);
    expect(await count('ImportJob', 'id', [d91])).toBe(0);
    expect(await count('ImportJobHistory', 'importId', [d91])).toBe(0);
    expect(await kit.exists(key91)).toBe(false);
    expect((await kit.job(d10)).errorReportKey).toBe(key10);
    expect(await kit.exists(key10)).toBe(true);
    expect((await kit.job(old)).status).toBe('UPLOADED'); // never a non-final job
    expect(await kit.lifecycle.purge()).toEqual({ records: 0, reports: 0 });
  }, 60_000);

  it('S07 AS-67: one run handles at most 500 jobs, and the next run takes the rest', async () => {
    const s = await seller();
    const src = await kit.uploaded(s, catalogCsv(2));
    await kit.deliver(src);
    await age(src, 91);
    const columns = (
      await kit.db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'ImportJob' ORDER BY ordinal_position`,
        { type: QueryTypes.SELECT },
      )
    ).map((c) => c.column_name);
    const list = columns.map((c) => `"${c}"`).join(', ');
    const values = columns
      .map((c) =>
        c === 'id'
          ? 'gen_random_uuid()'
          : c === 'storageKey'
            ? `'imports/' || j."shopId" || '/' || gen_random_uuid() || '/source'`
            : `j."${c}"`,
      )
      .join(', ');
    await kit.db.query(
      `INSERT INTO "ImportJob" (${list}) SELECT ${values} FROM "ImportJob" j CROSS JOIN generate_series(1, 501) n WHERE j."id" = :src`,
      { replacements: { src } },
    );
    const first = await kit.lifecycle.purge();
    expect(first.records).toBe(500);
    const second = await kit.lifecycle.purge();
    expect(second.records).toBe(2);
    expect(await kit.lifecycle.purge()).toEqual({ records: 0, reports: 0 });
  }, 120_000);

  it('S07 AS-68: log lines name the import and the shop and carry no row data, URL or signature; the metrics count rows by outcome, jobs by status and durations', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          lines.push(JSON.stringify(args));
        }),
    );
    try {
      const s = await seller();
      const rowsBefore =
        MetricsRegistry.value('catalog_import_rows_total', {
          outcome: 'created',
        }) ?? 0;
      const failedBefore =
        MetricsRegistry.value('catalog_import_rows_total', {
          outcome: 'failed',
        }) ?? 0;
      const doneBefore =
        MetricsRegistry.value('catalog_import_finished_total', {
          status: 'DONE',
        }) ?? 0;
      const batchesBefore =
        MetricsRegistry.histogramValue('catalog_import_batch_seconds')?.count ??
        0;
      const start = await kit
        .as(s.owner)
        .post(base(s))
        .set('Idempotency-Key', `key-${randomUUID()}`)
        .send({ fileName: 'secret-customer-list.csv', sizeBytes: 100 });
      expect(start.status).toBe(201);
      const id = await kit.uploaded(s, catalogCsv(8, { bad: [2] }));
      await kit.deliver(id);

      const own = lines.filter((l) => l.includes('"import.'));
      expect(own.length).toBeGreaterThan(0);
      for (const line of own.filter((l) => !l.includes('import.cancelled'))) {
        expect(line).toContain(s.shop.id);
      }
      expect(own.some((l) => l.includes(id) && l.includes(s.shop.id))).toBe(
        true,
      );
      expect(own.some((l) => l.includes('requestId'))).toBe(true);
      const all = lines.join('\n');
      for (const secret of [
        'SKU-',
        'secret-customer-list',
        'X-Amz',
        'http://',
        'https://',
        'EICAR',
        'FOUND',
      ])
        expect(all).not.toContain(secret);

      expect(
        MetricsRegistry.value('catalog_import_rows_total', {
          outcome: 'created',
        }),
      ).toBe(rowsBefore + 7);
      expect(
        MetricsRegistry.value('catalog_import_rows_total', {
          outcome: 'failed',
        }),
      ).toBe(failedBefore + 1);
      expect(
        MetricsRegistry.value('catalog_import_finished_total', {
          status: 'DONE',
        }),
      ).toBe(doneBefore + 1);
      expect(
        MetricsRegistry.histogramValue('catalog_import_batch_seconds')!.count,
      ).toBeGreaterThan(batchesBefore);
      expect(
        MetricsRegistry.histogramValue('catalog_import_scan_seconds')!.count,
      ).toBeGreaterThan(0);
      expect(
        MetricsRegistry.value('catalog_import_bytes_read_total'),
      ).toBeGreaterThan(0);
      expect(
        MetricsRegistry.labelSets('catalog_import_rows_total').every(
          (l) => Object.keys(l).join() === 'outcome',
        ),
      ).toBe(true);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  }, 60_000);

  it('S07 AS-70: this domain serves no export route, and its queue messages carry only the import id', async () => {
    const s = await seller();
    const post = await kit
      .as(s.owner)
      .post(`/api/shops/${s.shop.id}/exports/orders`)
      .send({});
    expect(post.status).toBe(404);
    const get = await kit
      .as(s.owner)
      .get(`/api/shops/${s.shop.id}/exports/${randomUUID()}`);
    expect(get.status).toBe(404);

    // the complete route's message is asserted in AS-07; recovery sends through the same queue port
    const id = await kit.uploaded(s, catalogCsv(3));
    kit.clock.advance(3 * 60_000);
    await kit.lifecycle.recoverStalled();
    const messages = kit.enqueued.filter((m) => m.queue === 'catalog-imports');
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages)
      expect(m.body).toEqual({ importId: expect.any(String) });
    expect(
      messages.map((m) => (m.body as { importId: string }).importId),
    ).toContain(id);
  });
});
