import {
  importErrorReportSchema,
  importJobSchema,
} from '@marketplace-sandbox/contracts';
import {
  DAY,
  MIN,
  T,
  catalogCsv,
  createImportApp,
  type ImportKit,
  type Seller,
} from './testing/import-kit';

/** The byte right after the header and the first `records` records. */
const endOf = (file: Buffer, records: number): number => {
  let seen = 0;
  for (let i = 0; i < file.length; i++)
    if (file[i] === 0x0a && ++seen === records + 1) return i + 1;
  return file.length;
};

/** A CSV of `rows` records whose chosen rows carry the given cell values (everything else is valid). */
const csvWith = (
  rows: number,
  overrides: Record<
    number,
    Partial<Record<'sku' | 'title' | 'price' | 'stock', string>>
  >,
): Buffer => {
  const lines = Array.from({ length: rows }, (_, i) => {
    const n = i + 1;
    const o = overrides[n] ?? {};
    return [
      o.sku ?? `SKU-${n}`,
      o.title ?? `Cable ${n}`,
      '2 m',
      o.price ?? `${(n % 50) + 1}.99`,
      o.stock ?? `${n % 7}`,
      'cables',
      'Anker',
    ].join(',');
  });
  return Buffer.from(
    'sku,title,description,price,stock,category,brand\n' +
      lines.join('\n') +
      '\n',
  );
};

describe('Bulk import error report', () => {
  let kit: ImportKit;
  const shops: string[] = [];

  beforeAll(async () => {
    kit = await createImportApp();
  });
  afterAll(async () => {
    await kit.forget(shops);
    await kit.close();
  });
  beforeEach(async () => {
    await kit.reset();
  });
  afterEach(async () => {
    kit.probe.release();
    await kit.forget(shops.splice(0));
  });

  const seller = async (): Promise<Seller> => {
    const s = await kit.seller();
    shops.push(s.shop.id);
    return s;
  };
  const base = (s: Seller) => `/api/shops/${s.shop.id}/imports`;
  const run = async (s: Seller, file: Buffer, fileName = 'catalog.csv') => {
    const id = await kit.uploaded(s, file, { fileName });
    const outcome = await kit.deliver(id);
    return { id, outcome, job: await kit.job(id) };
  };
  const reportLines = async (key: string) =>
    (await kit.objectText(key)).trim().split('\n');
  const waitFor = async (check: () => Promise<boolean>, ms = 20_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('condition not reached in time');
  };

  it('S07 AS-29: the report link is a ten-minute attachment of text/csv on the user-content origin; no route links the source file', async () => {
    const s = await seller();
    const { id, job } = await run(
      s,
      csvWith(20, { 3: { title: '' } }),
      'my catalog.csv',
    );
    expect(job.status).toBe('DONE');
    const res = await kit.as(s.owner).get(`${base(s)}/${id}/error-report`);
    expect(res.status).toBe(200);
    const report = importErrorReportSchema.parse(res.body);
    expect(report.rows).toBe(1);
    expect(report.expiresAt).toBe(
      new Date(T.getTime() + 10 * MIN).toISOString(),
    );
    const url = new URL(report.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="errors-my catalog.csv"',
    );
    expect(url.searchParams.get('response-content-type')).toBe(
      'text/csv; charset=utf-8',
    );
    expect(url.pathname).toContain('/report/errors.csv');
    expect(url.pathname).not.toContain('/source');
    // the application origin is not the user-content origin (a different site)
    expect(url.origin).not.toBe(new URL(res.request.url).origin);

    // none of the other routes names a file
    const surfaces = [
      await kit.as(s.owner).get(`${base(s)}/${id}`),
      await kit.as(s.owner).get(base(s)),
    ];
    for (const r of surfaces) {
      expect(JSON.stringify(r.body)).not.toContain('/source');
      expect(JSON.stringify(r.body)).not.toContain('X-Amz');
    }
    // and the link downloads the report
    const body = await (await fetch(report.url)).text();
    expect(body.split('\n')[0]).toBe('row,sku,field,code,message');
  });

  it('S07 AS-47: 10,000 rows with refusals produce a report in file order, one line per problem, with the row ordinal; progress followed every batch', async () => {
    const s = await seller();
    const file = csvWith(10_000, {
      17: { title: '' },
      5001: { price: 'abc', stock: '-1' },
      9999: { stock: '-1' },
    });
    const { id, outcome, job } = await run(s, file);
    expect(outcome).toBe('done');
    expect(job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 10_000,
      rowsFailed: 3,
      rowsCreated: 9997,
      errorReportRows: 4,
    });
    expect((await kit.productsOf(s.shop.id)).size).toBe(9997);
    const lines = await reportLines(job.errorReportKey!);
    expect(lines[0]).toBe('row,sku,field,code,message');
    expect(
      lines.slice(1).map((l) => l.split(',').slice(0, 4).join(',')),
    ).toEqual([
      '17,SKU-17,title,missing_required',
      '5001,SKU-5001,price,invalid_price',
      '5001,SKU-5001,stock,invalid_stock',
      '9999,SKU-9999,stock,invalid_stock',
    ]);
    for (const line of lines.slice(1))
      expect(line.split(',').slice(4).join(',').length).toBeGreaterThan(10);
    expect(kit.rt.of(id).filter((e) => e.type === 'progress')).toHaveLength(20);
  }, 180_000);

  it('S07 AS-48: values the file rules accept but the catalog refuses are reported with the catalog code and the file column; their neighbours are imported', async () => {
    const s = await seller();
    const file = csvWith(10, {
      2: { price: '0' },
      4: { title: 'T'.repeat(201) },
      6: { sku: 'S'.repeat(129) },
    });
    const { job } = await run(s, file);
    expect(job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 10,
      rowsFailed: 3,
      rowsCreated: 7,
    });
    const lines = (await reportLines(job.errorReportKey!))
      .slice(1)
      .map((l) => l.split(',').slice(0, 4));
    expect(lines.map((l) => [l[0], l[2], l[3]])).toEqual([
      ['2', 'price', 'invalid'],
      ['4', 'title', 'invalid'],
      ['6', 'sku', 'invalid'],
    ]);
    expect((await kit.productsOf(s.shop.id)).size).toBe(7);
  });

  it('S07 AS-49: refusals before and after a crash each appear once, in file order, and rowsFailed counts them', async () => {
    const s = await seller();
    const file = csvWith(3000, {
      100: { title: '' },
      1200: { price: 'abc' },
      2800: { stock: '-1' },
    });
    const id = await kit.uploaded(s, file);
    const a = kit.newRunner();
    kit.probe.freezeAfter(endOf(file, 1500), { once: true, skip: 2 });
    const first = a.handle(id, 1).catch((e: unknown) => e);
    await kit.probe.reached;
    await waitFor(async () => (await kit.job(id)).lastRow === 1500);
    await a.shutdown(); // the worker dies after batch 3
    kit.probe.release();
    await first;
    expect(await kit.newRunner().handle(id, 2)).toBe('done');
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 3000,
      rowsFailed: 3,
    });
    const lines = (await reportLines(job.errorReportKey!)).slice(1);
    expect(lines.map((l) => l.split(',').slice(0, 4).join(','))).toEqual([
      '100,SKU-100,title,missing_required',
      '1200,SKU-1200,price,invalid_price',
      '2800,SKU-2800,stock,invalid_stock',
    ]);
  }, 90_000);

  it('S07 AS-49: a batch redone after a crash replaces its report part instead of repeating its lines', async () => {
    const s = await seller();
    const file = csvWith(1500, { 600: { title: '' }, 1100: { price: 'abc' } });
    const id = await kit.uploaded(s, file);
    // the commit of batch 2 (rows 501 to 1000) fails after its report part was stored; the batch is redone
    await kit.db.query(`
      CREATE OR REPLACE FUNCTION import_test_fault() RETURNS trigger AS $$
      BEGIN
        IF NEW."lastRow" = 1000 AND OLD."lastRow" <> NEW."lastRow" THEN
          RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = '57014';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS import_test_fault ON "ImportJob";
      CREATE TRIGGER import_test_fault BEFORE UPDATE ON "ImportJob" FOR EACH ROW EXECUTE FUNCTION import_test_fault();`);
    try {
      await expect(kit.deliver(id, 1)).rejects.toThrow();
    } finally {
      await kit.db.query(
        `DROP TRIGGER IF EXISTS import_test_fault ON "ImportJob"`,
      );
    }
    expect(await kit.deliver(id, 2)).toBe('done');
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 1500,
      rowsFailed: 2,
      errorReportRows: 2,
    });
    const lines = (await reportLines(job.errorReportKey!)).slice(1);
    expect(lines.map((l) => l.split(',')[0])).toEqual(['600', '1100']);
  }, 60_000);

  describe('availability (AS-50)', () => {
    const asReport = async (s: Seller, id: string) =>
      kit.as(s.owner).get(`${base(s)}/${id}/error-report`);
    const view = async (s: Seller, id: string) =>
      importJobSchema.parse(
        (await kit.as(s.owner).get(`${base(s)}/${id}`)).body,
      );

    it('S07 AS-50: while the import runs the report is 409 error_report_not_ready; status shows the lines so far', async () => {
      const s = await seller();
      const file = csvWith(1500, { 10: { title: '' } });
      const id = await kit.uploaded(s, file);
      kit.probe.freezeAfter(endOf(file, 500), { once: true, skip: 2 });
      const running = kit.newRunner().handle(id, 1);
      await kit.probe.reached;
      await waitFor(async () => (await kit.job(id)).lastRow === 500);
      const res = await asReport(s, id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('error_report_not_ready');
      expect((await view(s, id)).errorReport).toEqual({
        available: false,
        rows: 1,
      });
      kit.probe.release();
      expect(await running).toBe('done');
      expect((await view(s, id)).errorReport).toEqual({
        available: true,
        rows: 1,
      });
    }, 60_000);

    it('S07 AS-50: a DONE import with no refused row has no report: 404 import_error_report_not_found', async () => {
      const s = await seller();
      const { id } = await run(s, catalogCsv(10));
      const res = await asReport(s, id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('import_error_report_not_found');
      expect((await view(s, id)).errorReport).toEqual({
        available: false,
        rows: 0,
      });
    });

    it('S07 AS-50: a FAILED import after some refusals still gives the lines found so far', async () => {
      const s = await seller();
      const head = csvWith(600, { 5: { title: '' } }).toString('utf8');
      const { id, outcome } = await run(
        s,
        Buffer.from(head + 'BAD,ti"tle,"d",1.00,1,c,b\n'),
      );
      expect(outcome).toBe('failed');
      const res = await asReport(s, id);
      expect(res.status).toBe(200);
      expect(importErrorReportSchema.parse(res.body).rows).toBe(1);
      expect((await view(s, id)).errorReport).toEqual({
        available: true,
        rows: 1,
      });
    });

    it('S07 AS-50: a CANCELLED import after some refusals still gives the lines found so far', async () => {
      const s = await seller();
      const file = csvWith(1500, { 10: { title: '' } });
      const id = await kit.uploaded(s, file);
      kit.probe.freezeAfter(endOf(file, 500), { once: true, skip: 2 });
      const running = kit.newRunner().handle(id, 1);
      await kit.probe.reached;
      await waitFor(async () => (await kit.job(id)).lastRow === 500);
      expect(
        (await kit.as(s.owner).post(`${base(s)}/${id}/cancel`)).status,
      ).toBe(200);
      kit.probe.release();
      expect(await running).toBe('cancelled');
      const res = await asReport(s, id);
      expect(res.status).toBe(200);
      expect(importErrorReportSchema.parse(res.body).rows).toBe(1);
    }, 60_000);

    it('S07 AS-50: after the 30-day retention the report is gone: 404, and the status says it is not available', async () => {
      const s = await seller();
      const { id, job } = await run(s, csvWith(20, { 3: { title: '' } }));
      expect((await asReport(s, id)).status).toBe(200);
      kit.clock.advance(31 * DAY);
      await kit.reauth(s.owner);
      expect(await kit.lifecycle.purge()).toMatchObject({ reports: 1 });
      expect(await kit.exists(job.errorReportKey!)).toBe(false);
      const res = await asReport(s, id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('import_error_report_not_found');
      expect((await view(s, id)).errorReport).toEqual({
        available: false,
        rows: 1,
      });
    });
  });
});
