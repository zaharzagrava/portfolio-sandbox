import { INestApplication, Module } from '@nestjs/common';
import { getConnectionToken, getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { buffer } from 'node:stream/consumers';
import sharp from 'sharp';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { MediaModule } from './media.module';
import { MediaService } from './application/media.service';
import { MediaProcessor, Sql } from './infra/media-processor';

@Module({ imports: [MediaModule, SequelizeModule.forFeature([Shop])] })
class SpecModule {}

/**
 * SD-10 against real Postgres + MinIO (S3 API): upload contract → the same
 * MediaProcessor the Lambda runs (wired to the test DB and MinIO) → READY,
 * EXIF-free variants, duplicate detection, outbox event.
 */
describe('Media pipeline (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let media: MediaService;
  let storage: ObjectStorage;
  let db: Sequelize;
  let processor: MediaProcessor;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], { stores: ['storage', 'sqs'] });
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    media = app.get(MediaService);
    storage = app.get(ObjectStorage);
    db = app.get(getConnectionToken());
    jest.spyOn(app.get(TaskQueue), 'enqueue').mockResolvedValue('msg');
    // Same positional-SQL contract as pg.Pool in the Lambda, backed by Sequelize bind parameters.
    const sql: Sql = async (text, params) => (await db.query(text, { bind: params, type: QueryTypes.SELECT })) as never;
    processor = new MediaProcessor(sql, (fn) => db.transaction((t) => fn(async (text, params) => (await db.query(text, { bind: params, type: QueryTypes.SELECT, transaction: t })) as never)), {
      get: async (key) => buffer(await storage.getStream(key)),
      put: (key, body, contentType) => storage.put(key, body, contentType),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
  });

  const photo = (color: { r: number; g: number; b: number }, withGps = true) => {
    const img = sharp({ create: { width: 1800, height: 1200, channels: 3, background: color } }).composite([{ input: Buffer.from('<svg width="1800" height="1200"><circle cx="600" cy="600" r="300" fill="white"/></svg>') }]).jpeg();
    return (withGps ? img.withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 27/1 0/1' } }) : img).toBuffer();
  };

  const uploaded = async (shopId: string, userId: string, bytes: Buffer) => {
    const { mediaId } = await media.createUpload(userId, 'product', shopId);
    const [{ originalKey }] = await db.query<{ originalKey: string }>(`SELECT "originalKey" FROM "Media" WHERE id = :mediaId`, { type: QueryTypes.SELECT, replacements: { mediaId } });
    await storage.put(originalKey, bytes, 'image/jpeg'); // what the browser does with the presigned POST
    return { mediaId, originalKey };
  };

  it('presigned POST: server-chosen key under the shop, image/* only, 15 MB cap - the API never sees bytes', async () => {
    const shop = await app.get<typeof Shop>(getModelToken(Shop)).create({ name: 'S', slug: `s-${v4().slice(0, 8)}` });
    const [user] = await seeds.createTreelike([{ __type__: TableName.User }]);
    const res = await media.createUpload(user.id, 'product', shop.id);
    expect(res.maxBytes).toBe(15 * 1024 * 1024);
    expect(res.upload.key).toMatch(new RegExp(`^media/originals/shops/${shop.id}/[0-9a-f-]{36}$`));
    // The limits live in the signed POLICY (S3 enforces them on upload), not in the client's hands.
    const policy = JSON.parse(Buffer.from(res.upload.fields.Policy ?? res.upload.fields.policy, 'base64').toString());
    expect(JSON.stringify(policy.conditions)).toContain('image/');
    expect(policy.conditions).toContainEqual(['content-length-range', expect.any(Number), 15 * 1024 * 1024]);
    await expect(media.createUpload(user.id, 'product', null)).rejects.toMatchObject({ status: 400 });
  });

  it('processing: READY with stripped-metadata WebP variants, outbox event, idempotent re-run; garbage is REJECTED', async () => {
    const shop = await app.get<typeof Shop>(getModelToken(Shop)).create({ name: 'S', slug: `s-${v4().slice(0, 8)}` });
    const [user] = await seeds.createTreelike([{ __type__: TableName.User }]);
    const { mediaId, originalKey } = await uploaded(shop.id, user.id, await photo({ r: 220, g: 40, b: 40 }));

    expect(await processor.process(originalKey)).toBe('READY');
    expect(await processor.process(originalKey)).toBe('SKIPPED'); // duplicate S3 event
    const view = await media.get(mediaId);
    expect(view.status).toBe('READY');
    const [full] = await db.query<{ variants: Record<string, { key: string; width: number }> }>(`SELECT variants FROM "Media" WHERE id = :mediaId`, { type: QueryTypes.SELECT, replacements: { mediaId } });
    expect(full.variants.full.width).toBe(1600);
    const derived = await buffer(await storage.getStream(full.variants.feed.key));
    expect((await sharp(derived).metadata()).exif).toBeUndefined();
    const [{ n }] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM "Outbox" WHERE "eventName" = 'media.ready' AND "aggregateId" = :mediaId`, { type: QueryTypes.SELECT, replacements: { mediaId } });
    expect(Number(n)).toBe(1);

    const bad = await uploaded(shop.id, user.id, Buffer.from('<?php system($_GET["c"]); ?>'));
    expect(await processor.process(bad.originalKey)).toBe('REJECTED');
    expect((await media.get(bad.mediaId)).status).toBe('REJECTED');
  });

  it('a re-saved copy of another shop\'s photo is flagged as a possible duplicate', async () => {
    const shops = await app.get<typeof Shop>(getModelToken(Shop)).bulkCreate([
      { name: 'Original', slug: `o-${v4().slice(0, 8)}` },
      { name: 'Copycat', slug: `c-${v4().slice(0, 8)}` },
    ]);
    const [user] = await seeds.createTreelike([{ __type__: TableName.User }]);
    const original = await photo({ r: 30, g: 90, b: 200 }, false);
    const first = await uploaded(shops[0].id, user.id, original);
    await processor.process(first.originalKey);
    const copy = await uploaded(shops[1].id, user.id, await sharp(original).resize(900).jpeg({ quality: 55 }).toBuffer());
    await processor.process(copy.originalKey);
    const [row] = await db.query<{ possibleDuplicateOf: string }>(`SELECT "possibleDuplicateOf" FROM "Media" WHERE id = :id`, { type: QueryTypes.SELECT, replacements: { id: copy.mediaId } });
    expect(row.possibleDuplicateOf).toBe(first.mediaId);
  });
});
