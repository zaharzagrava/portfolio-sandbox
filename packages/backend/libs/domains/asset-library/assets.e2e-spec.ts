import { INestApplication, Module } from '@nestjs/common';
import { getConnectionToken, getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { buffer } from 'node:stream/consumers';
import { randomBytes } from 'node:crypto';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { BisOrderModel as BisOrder, BisOrderItemModel as BisOrderItem } from '@app/domains/orders';
import { AssetsModule } from './assets.module';
import { AssetsService } from './application/assets.service';
import { chunk } from './domain/fastcdc';

@Module({ imports: [AssetsModule, SequelizeModule.forFeature([Shop, BisOrder, BisOrderItem])] })
class SpecModule {}

const PARAMS = { min: 4 * 1024, avg: 16 * 1024, max: 64 * 1024 };

/** SD-25 against real Postgres + MinIO. The client side (chunking + PUTs) is played by the spec. */
describe('Asset library & digital delivery (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let assets: AssetsService;
  let storage: ObjectStorage;
  let db: Sequelize;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], { stores: ['storage'] });
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    assets = app.get(AssetsService);
    storage = app.get(ObjectStorage);
    db = app.get(getConnectionToken());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
  });

  const setup = async () => {
    const shop = await app.get<typeof Shop>(getModelToken(Shop)).create({ name: 'Studio', slug: `st-${v4().slice(0, 8)}` });
    const [user] = await seeds.createTreelike([{ __type__: TableName.User }]);
    return { shopId: shop.id, userId: user.id as string };
  };

  /** What a sync client does: chunk → ask what's missing → PUT only those → commit. Returns how many chunks were uploaded. */
  const sync = async (shopId: string, userId: string, path: string, data: Buffer, baseVersion: number, deviceId = 'laptop-1') => {
    const chunks = chunk(data, PARAMS);
    const { missing } = await assets.prepareUpload(shopId, chunks.map((c) => ({ hash: c.hash, size: c.length })));
    for (const m of missing) {
      const c = chunks.find((x) => x.hash === m.hash)!;
      await storage.put(`assets/${shopId}/chunks/${c.hash}`, data.subarray(c.offset, c.offset + c.length), 'application/octet-stream');
    }
    const commit = await assets.commit(shopId, userId, { path, baseVersion, chunks: chunks.map((c) => c.hash), size: data.length, deviceId });
    return { ...commit, uploaded: missing.length, total: chunks.length };
  };

  it('editing the middle of a file uploads only the changed chunks; the new version downloads byte-identical', async () => {
    const { shopId, userId } = await setup();
    const v1 = randomBytes(1024 * 1024);
    const first = await sync(shopId, userId, '/kits/brand-guide.pdf', v1, 0);
    expect(first.uploaded).toBe(first.total);

    const v2 = Buffer.concat([v1.subarray(0, 600_000), Buffer.from('revised pricing page'), v1.subarray(600_000)]);
    const second = await sync(shopId, userId, '/kits/brand-guide.pdf', v2, 1);
    expect(second).toMatchObject({ version: 2, conflicted: false });
    expect(second.uploaded).toBeLessThanOrEqual(3);

    const download = await assets.stream(second.assetId);
    expect((await buffer(download.body)).equals(v2)).toBe(true);
    expect((await assets.changes(shopId, 0)).changes.map((c) => c.version)).toEqual([1, 2]);
  });

  it('two devices editing the same version: the second save becomes a conflicted copy, nothing is lost', async () => {
    const { shopId, userId } = await setup();
    const base = randomBytes(100_000);
    await sync(shopId, userId, '/manual.txt', base, 0);
    await sync(shopId, userId, '/manual.txt', Buffer.concat([base, Buffer.from('A')]), 1, 'laptop-1');
    const b = await sync(shopId, userId, '/manual.txt', Buffer.concat([base, Buffer.from('B')]), 1, 'phone-2');
    expect(b.conflicted).toBe(true);
    expect(b.path).toMatch(/^\/manual \(conflicted copy phone-2 \d{4}-\d{2}-\d{2}\)\.txt$/);
  });

  it('deleting a version + GC frees only chunks no other version uses', async () => {
    const { shopId, userId } = await setup();
    const v1 = randomBytes(300_000);
    const first = await sync(shopId, userId, '/a.bin', v1, 0);
    await sync(shopId, userId, '/a.bin', Buffer.concat([v1.subarray(0, 150_000), randomBytes(50_000), v1.subarray(150_000)]), 1);
    await assets.deleteVersion(shopId, first.assetId, 1);
    await db.query(`UPDATE "AssetChunk" SET "unreferencedSince" = now() - interval '25 hours' WHERE "refCount" = 0 AND "shopId" = :shopId`, { replacements: { shopId } });

    expect(await assets.gc()).toBeGreaterThan(0);
    // GC is global, so assert on THIS shop: no unreferenced chunk left, and exactly v2's chunks remain.
    const [state] = await db.query<{ orphans: string; remaining: string }>(
      `SELECT count(*) FILTER (WHERE "refCount" = 0) AS orphans, count(*) AS remaining FROM "AssetChunk" WHERE "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
    const [{ chunks }] = await db.query<{ chunks: string[] }>(`SELECT chunks FROM "AssetVersion" WHERE "assetId" = :id AND version = 2`, { type: QueryTypes.SELECT, replacements: { id: first.assetId } });
    expect(Number(state.orphans)).toBe(0);
    expect(Number(state.remaining)).toBe(new Set(chunks).size);
    const current = await assets.stream(first.assetId); // v2 still downloads
    expect((await buffer(current.body)).length).toBe(350_000);
  });

  it('share links honour their download cap atomically', async () => {
    const { shopId, userId } = await setup();
    const { assetId } = await sync(shopId, userId, '/press-kit.zip', randomBytes(20_000), 0);
    const { token } = await assets.share(shopId, assetId, 24, 1);
    await buffer((await assets.redeemShare(token)).body);
    await expect(assets.redeemShare(token)).rejects.toMatchObject({ status: 410 });
  });

  it('digital products: only buyers with a paid order get a (short-lived, buyer-bound) download', async () => {
    const { shopId, userId } = await setup();
    const file = randomBytes(50_000);
    const { assetId } = await sync(shopId, userId, '/ebook.epub', file, 0);
    const [product, buyer, stranger] = await seeds.createTreelike([
      { __type__: TableName.Product, title: 'E-book', shopId },
      { __type__: TableName.User },
      { __type__: TableName.User },
    ]);
    await assets.linkDigitalProduct(shopId, product.id, assetId);
    const order = await app.get<typeof BisOrder>(getModelToken(BisOrder)).create({ userId: buyer.id, status: 'PAID', total: 999, currency: 'usd' } as never);
    await app.get<typeof BisOrderItem>(getModelToken(BisOrderItem)).create({ bisOrderId: order.id, productId: product.id, quantity: 1, priceAtPurchase: 999, shopId } as never);

    await expect(assets.digitalDownloadToken(stranger.id, product.id)).rejects.toMatchObject({ status: 403 });
    const { url } = await assets.digitalDownloadToken(buyer.id, product.id);
    const download = await assets.redeemDownload(url.split('/').pop()!);
    expect(download.licensedTo).toBe(buyer.id);
    expect((await buffer(download.body)).equals(file)).toBe(true);
    await expect(assets.redeemDownload('not-a-token')).rejects.toMatchObject({ status: 410 });
  });
});
