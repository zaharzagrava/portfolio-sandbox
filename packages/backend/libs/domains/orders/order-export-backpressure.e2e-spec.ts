import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  DAY,
  T,
  createExportApp,
  csvRows,
  seedBulkLines,
  startExport,
  waitFor,
  type ExportKit,
} from './testing/order-export.fixtures';

/** Its own file (L-008): 50,000 lines are the biggest case of the capability suite. */
describe('Order export: backpressure from storage to the order store', () => {
  let kit: ExportKit;
  const shops: string[] = [];

  beforeAll(async () => {
    kit = await createExportApp();
  });
  afterAll(async () => {
    await kit.forget(shops);
    await kit.close();
  });
  afterEach(async () => {
    kit.storageControl.reset();
    await kit.forget(shops.splice(0));
  });

  it('S12 AS-11: while storage accepts nothing at most 3,000 lines are read; once released all 50,000 lines are written, each once', async () => {
    const owner = await kit.newUser();
    const shop = await createShop(kit.app, owner);
    shops.push(shop.id);
    const product = await createProduct(kit.app, shop, {
      externalSku: 'SKU-BP',
    });
    await seedBulkLines(kit.app, {
      shopId: shop.id,
      productId: product.id,
      buyerId: owner.id,
      orders: 500,
      perOrder: 100,
      at: new Date(T.getTime() - DAY),
    });
    const res = await startExport(kit, owner, shop.id);
    const exportId = res.body.exportId as string;
    kit.storageControl.hold();
    kit.resetLinesRead();

    const running = kit.run.handle(exportId);
    await waitFor(
      'the export read its first batch',
      () => kit.linesRead() >= 1000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500)); // time enough to read everything if nothing held it back
    expect(kit.linesRead()).toBeLessThanOrEqual(3_000);

    kit.storageControl.release();
    await running;

    const job = await kit.jobs.findById(exportId);
    expect(job).toMatchObject({
      status: 'DONE',
      totalRows: 50_000,
      rowsWritten: 50_000,
    });
    const rows = csvRows(await kit.fileOf(exportId));
    expect(rows).toHaveLength(50_000);
    expect(new Set(rows.map((r) => r.split(',')[7])).size).toBe(50_000);
    // 50,000 lines take 17 s alone and over 60 s when other test processes share the machine
  }, 180_000);
});
