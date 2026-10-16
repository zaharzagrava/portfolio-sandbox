import { productEvents, productIdsOf } from '@app/test/utils/catalog-fixtures';
import { importEventSchemas } from '@marketplace-sandbox/contracts';
import {
  catalogCsv,
  catalogJsonl,
  createImportApp,
  type ImportKit,
  type Seller,
} from './testing/import-kit';

describe('Bulk import processing', () => {
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
    await kit.forget(shops.splice(0));
  });

  const seller = async (): Promise<Seller> => {
    const s = await kit.seller();
    shops.push(s.shop.id);
    return s;
  };
  /** Uploads `file` as a new import of the seller and runs it to its end. */
  const run = async (s: Seller, file: Buffer, fileName?: string) => {
    const id = await kit.uploaded(s, file, { fileName });
    const outcome = await kit.deliver(id);
    return { id, outcome, job: await kit.job(id) };
  };

  it('S07 AS-13: 1,200 valid rows end DONE in calls of 500, 500 and 200 with exact counters, products in minor units, the file deleted, one finished event and a done live event', async () => {
    const s = await seller();
    const file = catalogCsv(1200);
    const { id, outcome, job } = await run(s, file);

    expect(outcome).toBe('done');
    expect(job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 1200,
      rowsCreated: 1200,
      rowsUpdated: 0,
      rowsUnchanged: 0,
      rowsFailed: 0,
      bytesProcessed: file.length,
      scan: 'clean',
      failureCode: null,
      errorReportKey: null,
      errorReportRows: 0,
    });
    expect(job.startedAt).not.toBeNull();
    expect(job.finishedAt).not.toBeNull();
    expect(kit.catalogCalls().map((c) => c.skus.length)).toEqual([
      500, 500, 200,
    ]);
    expect(
      kit
        .catalogCalls()
        .every((c) => c.source === 'import' && c.shopId === s.shop.id),
    ).toBe(true);

    const products = await kit.productsOf(s.shop.id);
    expect(products.size).toBe(1200);
    // price of row n is ((n % 50) + 1).99 major units, stock is n % 7
    expect(products.get('SKU-1')).toMatchObject({
      title: 'Cable 1, braided',
      priceMinor: 299,
      quantity: 1,
    });
    expect(products.get('SKU-50')?.priceMinor).toBe(199);
    expect(products.get('SKU-7')).toMatchObject({
      priceMinor: 899,
      quantity: 0,
    });

    // the source is gone, there is no report, and the transitions are in the history
    expect(await kit.exists(job.storageKey)).toBe(false);
    expect((await kit.history(id)).map((h) => h.toStatus)).toEqual([
      'PENDING_UPLOAD',
      'UPLOADED',
      'SCANNING',
      'PROCESSING',
      'DONE',
    ]);
    const events = await kit.finishedEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('catalogsync.import_finished');
    expect(
      importEventSchemas['catalogsync.import_finished'].parse(
        events[0].payload,
      ),
    ).toMatchObject({
      importId: id,
      status: 'DONE',
      rowsProcessed: 1200,
      failureCode: null,
    });
    const live = kit.rt.of(id);
    expect(live.filter((e) => e.type === 'done')).toEqual([
      {
        topic: `import:${id}`,
        type: 'done',
        data: { rowsProcessed: 1200, rowsFailed: 0 },
        replay: true,
      },
    ]);
    expect(
      live
        .filter((e) => e.type === 'progress')
        .every((e) => e.replay === false),
    ).toBe(true);
  }, 120_000);

  it('S07 AS-14: a messy CSV (BOM, CRLF, odd header, quoted comma, newline and quotes, unknown column, blank line) is read as meant and equals the same catalog as JSON lines', async () => {
    const messy = Buffer.from(
      '﻿ SKU , Title ,Description,PRICE,Category,colour\r\n' +
        'A1,"Cable, braided","say ""hi""\nthere",12.99,cables,red\r\n' +
        '\r\n' +
        'A2,Plain,two metres,0.1,cables,blue\r\n',
    );
    const a = await seller();
    const csv = await run(a, messy, 'messy.csv');
    expect(csv.job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 2,
      rowsCreated: 2,
      ignoredColumns: ['colour'],
      format: 'csv',
    });
    const first = (await kit.productsOf(a.shop.id)).get('A1')!;
    expect(first).toMatchObject({
      title: 'Cable, braided',
      description: 'say "hi"\nthere',
      priceMinor: 1299,
      category: 'cables',
    });
    expect((await kit.productsOf(a.shop.id)).get('A2')?.priceMinor).toBe(10);

    const jsonl = Buffer.from(
      '﻿' +
        [
          {
            sku: 'A1',
            title: 'Cable, braided',
            description: 'say "hi"\nthere',
            price: '12.99',
            category: 'cables',
            colour: 'red',
          },
          {
            sku: 'A2',
            title: 'Plain',
            description: 'two metres',
            price: 0.1,
            category: 'cables',
            colour: 'blue',
          },
        ]
          .map((o) => JSON.stringify(o))
          .join('\n') +
        '\n',
    );
    const b = await seller();
    const lines = await run(b, jsonl, 'messy.jsonl');
    expect(lines.job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 2,
      ignoredColumns: ['colour'],
      format: 'jsonl',
    });
    const pick = (
      m: Map<
        string,
        {
          title: string;
          description: string;
          priceMinor: number;
          brand: string;
          category: string;
        }
      >,
    ) =>
      [...m.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([sku, p]) => ({
          sku,
          title: p.title,
          description: p.description,
          priceMinor: p.priceMinor,
          brand: p.brand,
          category: p.category,
        }));
    expect(pick(await kit.productsOf(b.shop.id))).toEqual(
      pick(await kit.productsOf(a.shop.id)),
    );
  });

  it.each([
    ['a missing price column', 'sku,title,category\nA,B,c\n', 'missing: price'],
    ['a missing sku column', 'title,price,category\nB,1,c\n', 'missing: sku'],
    [
      'a repeated column',
      'sku,title,price,category,price\nA,B,1,c,2\n',
      'repeated: price',
    ],
  ])(
    'S07 AS-16: %s ends FAILED invalid_header naming the column, with no catalog call and the file deleted',
    async (_name, text, detail) => {
      const s = await seller();
      const { job } = await run(s, Buffer.from(text));
      expect(job).toMatchObject({
        status: 'FAILED',
        failureCode: 'invalid_header',
        rowsProcessed: 0,
      });
      expect(job.failureDetail).toContain(detail);
      expect(kit.catalogCalls()).toEqual([]);
      expect(await kit.exists(job.storageKey)).toBe(false);
      expect((await kit.productsOf(s.shop.id)).size).toBe(0);
    },
  );

  it('S07 AS-17: importing the same file again changes nothing: all unchanged, same versions, no new product events', async () => {
    const s = await seller();
    const file = catalogCsv(1200);
    await run(s, file);
    const before = await kit.productsOf(s.shop.id);
    const ids = await productIdsOf(kit.app, s.shop.id);
    const sample = [ids[0], ids[600], ids[1199]];
    const eventsBefore = await Promise.all(
      sample.map((id) => productEvents(kit.app, id)),
    );

    const again = await run(s, file);
    expect(again.job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 1200,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsUnchanged: 1200,
    });
    const after = await kit.productsOf(s.shop.id);
    expect(after.size).toBe(1200);
    for (const [sku, p] of before)
      expect(after.get(sku)?.version).toBe(p.version);
    const eventsAfter = await Promise.all(
      sample.map((id) => productEvents(kit.app, id)),
    );
    expect(eventsAfter.map((e) => e.length)).toEqual(
      eventsBefore.map((e) => e.length),
    );
  }, 120_000);

  it('S07 AS-18: three changed prices and two new SKUs are updated and created; the rest is unchanged and the counters add up', async () => {
    const s = await seller();
    await run(s, catalogCsv(1200));
    const before = await kit.productsOf(s.shop.id);
    const changed = new Set([5, 600, 1000]);
    const second = catalogCsv(1202, {
      price: (n) => (changed.has(n) ? '777.77' : `${(n % 50) + 1}.99`),
    });
    const { job } = await run(s, second);
    expect(job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 1202,
      rowsUpdated: 3,
      rowsCreated: 2,
      rowsUnchanged: 1197,
      rowsFailed: 0,
    });
    expect(job.rowsProcessed).toBe(
      job.rowsCreated + job.rowsUpdated + job.rowsUnchanged + job.rowsFailed,
    );
    const after = await kit.productsOf(s.shop.id);
    for (const n of changed) {
      expect(after.get(`SKU-${n}`)).toMatchObject({
        priceMinor: 77_777,
        version: before.get(`SKU-${n}`)!.version + 1,
      });
    }
    expect(after.get('SKU-1')?.version).toBe(before.get('SKU-1')!.version);
    expect(after.size).toBe(1202);
  }, 120_000);

  it('S07 AS-19: the same SKU twice in a file: the later row wins, no error line, and no two catalog calls share a SKU', async () => {
    const s = await seller();
    const file = Buffer.from(
      'sku,title,price,category\n' +
        'A1,First,10.00,c\nB2,Other,1.00,c\nB3,Other,1.00,c\nB4,Other,1.00,c\nB5,Other,1.00,c\nB6,Other,1.00,c\n' +
        'A1,Second,20.00,c\n',
    );
    const { job } = await run(s, file);
    expect(job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 7,
      rowsFailed: 0,
      rowsCreated: 6,
      rowsUpdated: 1,
      errorReportKey: null,
    });
    const product = (await kit.productsOf(s.shop.id)).get('A1')!;
    expect(product).toMatchObject({ title: 'Second', priceMinor: 2000 });
    const calls = kit.catalogCalls();
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(new Set(c.skus).size).toBe(c.skus.length);
    expect(calls[0].skus).toContain('A1');
    expect(calls[1].skus).toEqual(['A1']);
  });

  it('S07 AS-20: an empty stock cell keeps the stock, 0 sets it to 0, and a file without the column keeps it too', async () => {
    const s = await seller();
    await run(
      s,
      Buffer.from('sku,title,price,category,stock\nA1,T,1.00,c,5\n'),
    );
    expect((await kit.productsOf(s.shop.id)).get('A1')?.quantity).toBe(5);

    await run(s, Buffer.from('sku,title,price,category,stock\nA1,T,1.00,c,\n'));
    expect((await kit.productsOf(s.shop.id)).get('A1')?.quantity).toBe(5);

    await run(s, Buffer.from('sku,title,price,category\nA1,T,1.00,c\n'));
    expect((await kit.productsOf(s.shop.id)).get('A1')?.quantity).toBe(5);

    await run(
      s,
      Buffer.from('sku,title,price,category,stock\nA1,T,1.00,c,0\n'),
    );
    expect((await kit.productsOf(s.shop.id)).get('A1')?.quantity).toBe(0);
  });

  it('S07 AS-13: JSON lines named .csv and CSV named .jsonl are read by what they contain', async () => {
    const s = await seller();
    const a = await run(s, catalogJsonl(5, 'J'), 'looks-like.csv');
    const b = await run(s, catalogCsv(5, { prefix: 'C' }), 'looks-like.jsonl');
    expect(a.job).toMatchObject({
      status: 'DONE',
      format: 'jsonl',
      rowsProcessed: 5,
    });
    expect(b.job).toMatchObject({
      status: 'DONE',
      format: 'csv',
      rowsProcessed: 5,
    });
  });
});
