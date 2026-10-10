import { INestApplication, Module } from '@nestjs/common';
import { getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { v4, v7 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { ProductModel as Product } from '@app/domains/catalog';
import { OfflineSyncModule } from './sync.module';
import { SyncService } from './application/sync.service';
import { encodeHlc } from './domain/hlc';

@Module({
  imports: [OfflineSyncModule, SequelizeModule.forFeature([Shop, Product])],
})
class SpecModule {}

/** SD-06 against real Postgres (trigger-fed change log). */
describe('Offline sync (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let sync: SyncService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule]);
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    sync = app.get(SyncService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
  });

  const setup = async (quantity = 10) => {
    const shop = await app
      .get<typeof Shop>(getModelToken(Shop))
      .create({ name: 'Pop-up', slug: `pop-${v4().slice(0, 8)}` });
    const [product] = await seeds.createTreelike([
      {
        __type__: TableName.Product,
        title: 'Hoodie',
        shopId: shop.id,
        quantity,
        price: 5_000,
      },
    ]);
    return { shopId: shop.id, productId: product.id as string };
  };
  const hlc = (ms: number, node: string) =>
    encodeHlc({ physical: ms, logical: 0, node });
  const quantity = async (id: string) =>
    (await app.get<typeof Product>(getModelToken(Product)).findByPk(id))!
      .quantity;

  it('two offline devices: +3 received and −1 sold merge to base + 2, in either order; a replayed batch applies nothing', async () => {
    const { shopId, productId } = await setup(10);
    const now = Date.now();
    const a = [
      {
        type: 'stock.adjust' as const,
        opId: v7(),
        hlc: hlc(now - 60_000, 'dev-a'),
        productId,
        delta: 3,
        reason: 'received' as const,
      },
    ];
    const b = [
      {
        type: 'stock.adjust' as const,
        opId: v7(),
        hlc: hlc(now - 30_000, 'dev-b'),
        productId,
        delta: -1,
        reason: 'sold' as const,
      },
    ];

    await sync.push(shopId, 'dev-b', b); // device B reconnects first
    await sync.push(shopId, 'dev-a', a);
    expect(await quantity(productId)).toBe(12);

    const replay = await sync.push(shopId, 'dev-a', a);
    expect(replay.results[0].result).toBe('duplicate');
    expect(await quantity(productId)).toBe(12);
  });

  it('a stock count becomes a delta against what the device saw; selling the last unit twice is a reviewable conflict', async () => {
    const { shopId, productId } = await setup(1);
    const now = Date.now();
    await sync.push(shopId, 'dev-a', [
      {
        type: 'stock.count',
        opId: v7(),
        hlc: hlc(now, 'dev-a'),
        productId,
        counted: 1,
        base: 1,
      },
    ]); // count confirms
    const results = await Promise.all([
      sync.push(shopId, 'dev-a', [
        {
          type: 'stock.adjust',
          opId: v7(),
          hlc: hlc(now, 'dev-a'),
          productId,
          delta: -1,
          reason: 'sold',
        },
      ]),
      sync.push(shopId, 'dev-b', [
        {
          type: 'stock.adjust',
          opId: v7(),
          hlc: hlc(now, 'dev-b'),
          productId,
          delta: -1,
          reason: 'sold',
        },
      ]),
    ]);
    expect(results.map((r) => r.results[0].result).sort()).toEqual([
      'applied',
      'conflict',
    ]);
    expect(await quantity(productId)).toBe(0); // never negative (S05 FR-031, S09 AS-08)
    expect(await sync.conflicts(shopId)).toHaveLength(1);
  });

  it('LWW per field by HLC: concurrent title and price edits both survive; an older title edit loses', async () => {
    const { shopId, productId } = await setup();
    const now = Date.now();
    await sync.push(shopId, 'dev-a', [
      {
        type: 'product.update',
        opId: v7(),
        hlc: hlc(now - 10_000, 'dev-a'),
        productId,
        fields: { title: 'Hoodie (black)' },
      },
    ]);
    await sync.push(shopId, 'dev-b', [
      {
        type: 'product.update',
        opId: v7(),
        hlc: hlc(now - 5_000, 'dev-b'),
        productId,
        fields: { price: 4_500 },
      },
    ]);
    const stale = await sync.push(shopId, 'dev-c', [
      {
        type: 'product.update',
        opId: v7(),
        hlc: hlc(now - 20_000, 'dev-c'),
        productId,
        fields: { title: 'Old title' },
      },
    ]);
    expect(stale.results[0]).toMatchObject({
      result: 'merged',
      detail: { superseded: ['title'] },
    });
    const p = await app
      .get<typeof Product>(getModelToken(Product))
      .findByPk(productId);
    expect(p).toMatchObject({ title: 'Hoodie (black)' });
    expect(Number(p!.price)).toBe(4_500);
  });

  it('pull returns every product change after the cursor - including ones not made through sync - in seq order', async () => {
    const { shopId, productId } = await setup(10);
    const start = (await sync.pull(shopId, 0)).cursor;
    await app
      .get<typeof Product>(getModelToken(Product))
      .update({ quantity: 7 }, { where: { id: productId } }); // e.g. an online order
    await sync.push(shopId, 'dev-a', [
      {
        type: 'stock.adjust',
        opId: v7(),
        hlc: hlc(Date.now(), 'dev-a'),
        productId,
        delta: 5,
        reason: 'received',
      },
    ]);
    const { changes, cursor, hasMore } = await sync.pull(shopId, start);
    expect(
      changes.map((c) => (c.data as { quantity: number }).quantity),
    ).toEqual([7, 12]);
    expect(changes[1].seq).toBe(changes[0].seq + 1);
    expect(hasMore).toBe(false);
    expect((await sync.pull(shopId, cursor)).changes).toEqual([]);
  });

  it('rejects ops with clocks far in the future (they would win every LWW race)', async () => {
    const { shopId, productId } = await setup();
    const res = await sync.push(shopId, 'dev-x', [
      {
        type: 'product.update',
        opId: v7(),
        hlc: hlc(Date.now() + 3_600_000, 'dev-x'),
        productId,
        fields: { title: 'Forever' },
      },
    ]);
    expect(res.results[0].result).toBe('rejected');
  });
});
