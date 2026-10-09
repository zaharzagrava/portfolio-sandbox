import { INestApplication, Module } from '@nestjs/common';
import {
  getConnectionToken,
  getModelToken,
  SequelizeModule,
} from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { buffer } from 'node:stream/consumers';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { CatalogImportModule } from './catalog-import.module';
import { CatalogImportService } from './application/catalog-import.service';
import { OrderExportService } from '@app/domains/orders';

@Module({ imports: [CatalogImportModule, SequelizeModule.forFeature([Shop])] })
class SpecModule {}

/** SD-27 against real Postgres + Redis + MinIO (the worker's `process` called directly; S3 multipart is MinIO-native). */
describe('Bulk catalog import & export (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let imports: CatalogImportService;
  let storage: ObjectStorage;
  let db: Sequelize;
  let progress: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], {
      stores: ['redis', 'storage', 'sqs'],
    });
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    imports = app.get(CatalogImportService);
    storage = app.get(ObjectStorage);
    db = app.get(getConnectionToken());
    progress = jest.spyOn(app.get(RealtimePublisher), 'publish');
    jest.spyOn(app.get(TaskQueue), 'enqueue').mockResolvedValue('m');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    progress.mockClear();
  });

  const csv = (rows: number, bad: number[]) =>
    Buffer.from(
      '﻿sku,title,description,price,stock,category,brand\n' +
        Array.from({ length: rows }, (_, i) =>
          bad.includes(i + 1)
            ? `SKU-${i + 1},,"no title",abc,-1,cables,`
            : `SKU-${i + 1},"Cable ${i + 1}, braided","2 m",${(i % 50) + 1}.99,${i % 7},cables,Anker`,
        ).join('\n') +
        '\n',
    );

  /** Simulates the browser's completed multipart upload: object in MinIO + job UPLOADED. */
  const uploadedJob = async (
    shopId: string,
    userId: string,
    file: Buffer,
    extra: Record<string, unknown> = {},
  ) => {
    const id = v4();
    const key = `imports/${shopId}/${id}/source`;
    await storage.put(key, file, 'text/csv');
    await db.query(
      `INSERT INTO "ImportJob" (id, "shopId", "createdBy", "fileName", "objectKey", "sizeBytes", status, "checkpointRow", "rowsProcessed")
       VALUES (:id, :shopId, :userId, 'catalog.csv', :key, :size, :status, :checkpoint, :processed)`,
      {
        replacements: {
          id,
          shopId,
          userId,
          key,
          size: file.length,
          status: extra.status ?? 'UPLOADED',
          checkpoint: extra.checkpointRow ?? 0,
          processed: extra.rowsProcessed ?? 0,
        },
      },
    );
    return id;
  };

  const setup = async () => {
    const shop = await app
      .get<typeof Shop>(getModelToken(Shop))
      .create({ name: 'Cables Inc', slug: `c-${v4().slice(0, 8)}` });
    const [user] = await seeds.createTreelike([{ __type__: TableName.User }]);
    return { shopId: shop.id, userId: user.id as string };
  };
  const productCount = async (shopId: string) =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM "Product" WHERE "shopId" = :shopId`,
          { type: QueryTypes.SELECT, replacements: { shopId } },
        )
      )[0].n,
    );

  it('10k rows with 3 bad ones → 9,997 products, a 3-line error report, progress events; re-import upserts (no duplicates)', async () => {
    const { shopId, userId } = await setup();
    const file = csv(10_000, [17, 5_001, 9_999]);
    const jobId = await uploadedJob(shopId, userId, file);

    expect(await imports.process(jobId)).toBe('DONE');
    expect(await productCount(shopId)).toBe(9_997);
    const status = await imports.status(shopId, jobId);
    expect(status).toMatchObject({
      status: 'DONE',
      rowsProcessed: 10_000,
      rowsFailed: 3,
    });
    const [{ errorReportKey }] = await db.query<{ errorReportKey: string }>(
      `SELECT "errorReportKey" FROM "ImportJob" WHERE id = :jobId`,
      { type: QueryTypes.SELECT, replacements: { jobId } },
    );
    const report = (await buffer(await storage.getStream(errorReportKey)))
      .toString()
      .trim()
      .split('\n');
    expect(report).toHaveLength(4); // header + 3
    expect(report[1]).toMatch(/^17,SKU-17,/);
    expect(
      progress.mock.calls.filter(
        ([topic, type]) => topic === `job:${jobId}` && type === 'progress',
      ),
    ).toHaveLength(10);

    const [p] = await db.query<{ price: string; title: string }>(
      `SELECT price, title FROM "Product" WHERE "shopId" = :shopId AND "externalSku" = 'SKU-1'`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
    expect(p).toMatchObject({ title: 'Cable 1, braided' });
    expect(Number(p.price)).toBe(199); // "1.99" → minor units

    const again = await uploadedJob(shopId, userId, file);
    await imports.process(again);
    expect(await productCount(shopId)).toBe(9_997);
  });

  it('resumes from the checkpoint after a crash (rows before it are not re-written)', async () => {
    const { shopId, userId } = await setup();
    const jobId = await uploadedJob(shopId, userId, csv(3_000, []), {
      status: 'PROCESSING',
      checkpointRow: 2_000,
      rowsProcessed: 2_000,
    });
    await imports.process(jobId);
    expect(await productCount(shopId)).toBe(1_000); // only rows 2,001-3,000 were written in this run
    expect(await imports.status(shopId, jobId)).toMatchObject({
      status: 'DONE',
      rowsProcessed: 3_000,
    });
  });

  it('content sniffing: a binary file named .csv is refused', async () => {
    const { shopId, userId } = await setup();
    const jobId = await uploadedJob(
      shopId,
      userId,
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]),
    );
    expect(await imports.process(jobId)).toBe('FAILED');
    expect((await imports.status(shopId, jobId)).status).toBe('FAILED');
  });

  it('order export streams to S3 and returns a presigned attachment download', async () => {
    const { shopId, userId } = await setup();
    const exports = app.get(OrderExportService);
    const { jobId } = await exports.request(shopId, userId);
    expect(await exports.run(jobId)).toBe(0);
    const status = await exports.status(shopId, jobId);
    expect(status.status).toBe('DONE');
    expect(status.downloadUrl).toContain(
      'response-content-disposition=attachment',
    );
  });
});
