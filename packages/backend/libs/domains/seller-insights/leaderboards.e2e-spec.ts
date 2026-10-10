import { INestApplication, Module } from '@nestjs/common';
import { getModelToken, SequelizeModule } from '@nestjs/sequelize';
import request from 'supertest';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ProductModel as Product } from '@app/domains/catalog';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { OrderPaid, OrderReserved } from '@app/domains/orders';
import { LeaderboardsModule } from './leaderboards.module';
import { LeaderboardsWorkerModule } from './leaderboards-worker.module';
import { LeaderboardProjector } from './infra/leaderboard.projector';
import { ShopLiveProjector } from './infra/shop-live.projector';
import { LeaderboardSnapshotJobs } from './infra/leaderboard-snapshot.jobs';
import { DashboardTicker } from './infra/dashboard-ticker.service';
import { boardKey, revenueKey, ALL } from './infra/leaderboard-keys';
import { periodOf } from './domain/periods';

@Module({
  imports: [SequelizeModule.forFeature([Product, Shop])],
  providers: [LeaderboardProjector, ShopLiveProjector],
})
class ProjectorsSpecModule {}

/** SD-18 against real Redis + Postgres. */
describe('Leaderboards & live dashboard (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let projector: LeaderboardProjector;
  let redis: RedisService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [
        LeaderboardsModule,
        LeaderboardsWorkerModule,
        ProjectorsSpecModule,
        SeedsModule,
      ],
      { stores: ['redis'] },
    );
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    seeds = app.get(SeedsService);
    projector = app.get(LeaderboardProjector);
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    const week = periodOf('week', new Date()).id;
    const keys = await redis.client.keys(`lb:{${week}}:*`);
    if (keys.length) await redis.client.del(...keys);
  });

  const shop = async (name: string) =>
    (
      await app
        .get<typeof Shop>(getModelToken(Shop))
        .create({ name, slug: `${name.toLowerCase()}-${v4().slice(0, 6)}` })
    ).id;
  const sale = (
    shopId: string,
    productId: string,
    price: number,
    at: Date,
    quantity = 1,
  ) => {
    const orderId = v4();
    return OrderPaid.create(
      orderId,
      2,
      {
        orderId,
        userId: v4(),
        orderVersion: 2,
        totalMinor: price * quantity,
        currency: 'usd',
        paymentRef: v4(),
        paidAt: at.toISOString(),
        lines: [
          {
            productId,
            shopId,
            title: 'Item',
            quantity,
            unitPriceMinor: price,
            discountMinor: 0,
            lineTotalMinor: price * quantity,
          },
        ],
        shopOrders: [],
      },
      at,
    );
  };

  it('ranks by revenue, earlier sale wins ties, replays never double count, per-category boards', async () => {
    const [alpha, beta] = [await shop('Alpha'), await shop('Beta')];
    const [phone, cable] = await seeds.createTreelike([
      { __type__: TableName.Product, title: 'Phone', category: 'electronics' },
      { __type__: TableName.Product, title: 'Cable', category: 'accessories' },
    ]);
    const now = Date.now();
    const first = sale(alpha, phone.id, 10_000, new Date(now - 60_000));
    await projector.project([
      first,
      sale(beta, phone.id, 10_000, new Date(now - 30_000)),
    ]);
    await projector.project([first]); // Kafka redelivery

    let board = (await http().get('/api/leaderboards?period=week').expect(200))
      .body;
    expect(
      board.entries.map((e: { name: string; revenue: number }) => [
        e.name,
        e.revenue,
      ]),
    ).toEqual([
      ['Alpha', 10_000],
      ['Beta', 10_000],
    ]);

    await projector.project([sale(beta, cable.id, 1, new Date(now))]);
    board = (await http().get('/api/leaderboards?period=week').expect(200))
      .body;
    expect(board.entries.map((e: { name: string }) => e.name)).toEqual([
      'Beta',
      'Alpha',
    ]);
    expect(
      (
        await http()
          .get('/api/leaderboards?period=week&category=accessories')
          .expect(200)
      ).body.entries.map((e: { name: string }) => e.name),
    ).toEqual(['Beta']);
    expect(
      (
        await http()
          .get('/api/leaderboards?period=month&category=electronics')
          .expect(200)
      ).body.entries,
    ).toHaveLength(2);

    expect(
      (
        await http()
          .get(`/api/leaderboards/shops/${alpha}?period=week`)
          .expect(200)
      ).body,
    ).toMatchObject({ rank: 2, of: 2, topPercent: 100, revenue: 10_000 });
  });

  it('a closed period is served from the Postgres snapshot after Redis forgets it', async () => {
    const [alpha] = [await shop('Alpha')];
    const [phone] = await seeds.createTreelike([
      { __type__: TableName.Product, title: 'Phone', category: 'electronics' },
    ]);
    await projector.project([sale(alpha, phone.id, 5_000, new Date())]);
    const week = periodOf('week', new Date()).id;

    expect(
      await app
        .get(LeaderboardSnapshotJobs)
        .snapshot({ kind: 'week', periodId: week }),
    ).toBe(2); // all + category board
    await redis.client.del(boardKey(week, ALL), revenueKey(week, ALL));

    const board = (
      await http().get(`/api/leaderboards?period=week&id=${week}`).expect(200)
    ).body;
    expect(board.entries).toEqual([
      { rank: 1, shopId: alpha, name: 'Alpha', revenue: 5_000 },
    ]);
  });

  it('live dashboard sums the last 60 one-second buckets: checkouts, orders, revenue, conversion', async () => {
    const shopId = v4();
    const live = app.get(ShopLiveProjector);
    const now = new Date();
    const reserve = () => {
      const orderId = v4();
      return OrderReserved.create(
        orderId,
        1,
        {
          orderId,
          orderVersion: 1,
          userId: v4(),
          totalMinor: 0,
          currency: 'usd',
          shopIds: [shopId],
          reservedUntil: now.toISOString(),
        },
        now,
      );
    };
    const paid = sale(shopId, v4(), 2_500, now, 2);
    await live.project([reserve(), reserve(), reserve(), reserve(), paid]);
    await live.project([paid]); // replay

    const dash = await app
      .get(DashboardTicker)
      .compute(shopId, Math.floor(now.getTime() / 1000));
    expect(dash.last60s).toEqual({
      checkouts: 4,
      orders: 1,
      units: 2,
      revenue: 5_000,
    });
    expect(dash.checkoutConversion).toBe(0.25);
    expect(dash.ordersPerSecond).toHaveLength(60);
    expect(dash.ordersPerSecond[59]).toBe(1);
  });
});
