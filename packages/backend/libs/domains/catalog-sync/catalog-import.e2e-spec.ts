import { QueryTypes } from 'sequelize';
import { ImportInterruptedError } from './domain/import-errors';
import { CatalogImportController } from './api/catalog-import.controller';
import {
  catalogCsv,
  createImportApp,
  type ImportKit,
  type Seller,
} from './testing/import-kit';

/** The byte right after the header and the first `records` records (the checkpoint a worker stops at). */
const endOf = (file: Buffer, records: number): number => {
  let seen = 0;
  for (let i = 0; i < file.length; i++)
    if (file[i] === 0x0a && ++seen === records + 1) return i + 1;
  return file.length;
};

/** The end-to-end path of a bulk import on the real stores (the former single spec of the module, kept as its smoke test). */
describe('Bulk catalog import (e2e)', () => {
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
  const waitFor = async (check: () => Promise<boolean>, ms = 20_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('condition not reached in time');
  };

  it('10k rows with 3 bad ones → 9,997 products, a 3-line error report, progress events; re-import changes nothing (no duplicates)', async () => {
    const s = await seller();
    const file = catalogCsv(10_000, { bad: [17, 5_001, 9_999] });
    const id = await kit.uploaded(s, file);

    expect(await kit.deliver(id)).toBe('done');
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 10_000,
      rowsFailed: 3,
      rowsCreated: 9_997,
    });
    const report = (await kit.objectText(job.errorReportKey!))
      .trim()
      .split('\n');
    expect(report).toHaveLength(10); // header + 3 bad rows × 3 field problems
    expect(new Set(report.slice(1).map((l) => l.split(',')[0]))).toEqual(
      new Set(['17', '5001', '9999']),
    );
    expect(report[1]).toMatch(/^17,/);
    expect(
      kit.rt.of(id).filter((e) => e.type === 'progress').length,
    ).toBeGreaterThan(0);

    const products = await kit.productsOf(s.shop.id);
    expect(products.size).toBe(9_997);
    expect(products.get('SKU-1')).toMatchObject({
      title: 'Cable 1, braided',
      priceMinor: 299,
    });

    const again = await kit.uploaded(s, file);
    await kit.deliver(again);
    expect(await kit.job(again)).toMatchObject({
      status: 'DONE',
      rowsCreated: 0,
      rowsUnchanged: 9_997,
      rowsFailed: 3,
    });
    const rows = await kit.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM "Product" WHERE "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId: s.shop.id } },
    );
    expect(Number(rows[0].n)).toBe(9_997);
  }, 180_000);

  it('resumes from the checkpoint after a crash (rows before it are not re-written)', async () => {
    const s = await seller();
    const file = catalogCsv(3_000);
    const id = await kit.uploaded(s, file);
    const a = kit.newRunner();
    kit.probe.freezeAfter(endOf(file, 1_500), { once: true, skip: 2 });
    const first = a.handle(id, 1).catch((e: unknown) => e);
    await kit.probe.reached;
    await waitFor(async () => (await kit.job(id)).lastRow >= 1_500);
    await a.shutdown();
    kit.probe.release();
    expect(await first).toBeInstanceOf(ImportInterruptedError);

    kit.resetCalls();
    expect(await kit.newRunner().handle(id, 2)).toBe('done');
    const sent = kit.catalogCalls().flatMap((c) => c.skus);
    expect(sent).toHaveLength(1_500); // only rows 1,501-3,000 were written in this run
    expect(sent).not.toContain('SKU-1500');
    expect(await kit.job(id)).toMatchObject({
      status: 'DONE',
      rowsProcessed: 3_000,
    });
    expect((await kit.productsOf(s.shop.id)).size).toBe(3_000);
  }, 90_000);

  it('content sniffing: a binary file named .csv is refused', async () => {
    const s = await seller();
    const id = await kit.uploaded(
      s,
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]),
      { fileName: 'catalog.csv' },
    );
    expect(await kit.deliver(id)).toBe('failed');
    expect(await kit.job(id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'unsupported_file_type',
    });
    expect(kit.catalogCalls()).toEqual([]);
  });

  // The order export moved to S12 (`orders/order-export.e2e-spec.ts`); this module must not bring it back.
  it('serves no order export: neither the service nor an export route is part of the import module', () => {
    expect(() =>
      kit.app.get('OrderExportService', { strict: false }),
    ).toThrow();
    const routes = Reflect.getMetadata(
      'path',
      CatalogImportController,
    ) as string;
    expect(String(routes)).not.toMatch(/export/i);
    const handlers = Object.getOwnPropertyNames(
      CatalogImportController.prototype,
    );
    expect(handlers.filter((h) => /export/i.test(h))).toEqual([]);
  });
});
