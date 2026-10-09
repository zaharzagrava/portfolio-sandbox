import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { SequelizeModule } from '@nestjs/sequelize';
import { Module } from '@nestjs/common';
import { DeliveryCoreModule } from './delivery-core.module';
import { DeliveryWorkerModule } from './delivery-worker.module';
import { CourierService } from './application/courier.service';
import { DispatchService } from './application/dispatch.service';
import { SurgeJob } from './infra/delivery-workers';
import { courierKey, geoKey } from './infra/courier-keys';
import { geohash } from './domain/geohash';

@Module({
  imports: [
    DeliveryCoreModule,
    DeliveryWorkerModule,
    SequelizeModule.forFeature([Shop]),
  ],
})
class SpecModule {}

// Pickup at Alexanderplatz; couriers ~0.3 km, ~1 km, ~2.5 km away.
const PICKUP = { lat: 52.5219, lng: 13.4132 };
const DROPOFF = { lat: 52.5096, lng: 13.3759 };
const NEAR = [
  { lat: 52.5245, lng: 13.4135 },
  { lat: 52.5309, lng: 13.4132 },
  { lat: 52.5444, lng: 13.4132 },
];

/** SD-23 against real Postgres + Redis (GEO, Lua) + ElasticMQ. */
describe('Courier dispatch (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let couriers: CourierService;
  let dispatch: DispatchService;
  let redis: RedisService;
  let city: string;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], {
      stores: ['redis', 'sqs'],
    });
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    couriers = app.get(CourierService);
    dispatch = app.get(DispatchService);
    redis = app.get(RedisService);
    jest
      .spyOn(app.get(KafkaProducerService), 'send')
      .mockResolvedValue(undefined as never);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    city = `berlin-${v4().slice(0, 6)}`; // fresh cell per test: no GEO leftovers
  });

  const fleet = async (positions = NEAR) => {
    const users = await seeds.createTreelike(
      positions.map(() => ({ __type__: TableName.User })),
    );
    for (const [i, u] of users.entries()) {
      await couriers.register(u.id, city, 'bike');
      await couriers.report(u.id, city, [{ ...positions[i], ts: Date.now() }]);
      await couriers.setAvailability(u.id, true);
    }
    return users.map((u) => u.id as string);
  };

  const order = async () => {
    const [buyer] = await seeds.createTreelike([{ __type__: TableName.User }]);
    const shop = await app
      .get<typeof Shop>(getModelToken(Shop))
      .create({ name: 'Local', slug: `l-${v4().slice(0, 8)}` });
    return dispatch.request({
      shopId: shop.id,
      buyerId: buyer.id,
      city,
      pickup: PICKUP,
      dropoff: DROPOFF,
    });
  };

  it('offers the nearest courier first; decline → next nearest; accept → ASSIGNED and the courier leaves the pool', async () => {
    const [c1, c2, c3] = await fleet();
    const d = await order();
    expect(d).toMatchObject({
      status: 'OFFERED',
      offeredCourierId: c1,
      attempt: 1,
    });

    await dispatch.decline(d.id, c1);
    expect(await dispatch.get(d.id)).toMatchObject({
      status: 'OFFERED',
      offeredCourierId: c2,
      attempt: 2,
    });

    await expect(dispatch.accept(d.id, c3)).rejects.toMatchObject({
      status: 409,
    }); // not their offer
    expect(await dispatch.accept(d.id, c2)).toMatchObject({
      status: 'ASSIGNED',
      courierId: c2,
    });

    const pool = await redis.client.zrange(geoKey(city), 0, -1);
    expect(pool.sort()).toEqual([c1, c3].sort());
    await dispatch.pickUp(d.id, c2);
    await dispatch.deliver(d.id, c2);
    expect((await redis.client.zrange(geoKey(city), 0, -1)).sort()).toEqual(
      [c1, c2, c3].sort(),
    ); // back in the pool
  });

  it('two concurrent deliveries can never be offered the same courier', async () => {
    const [only] = await fleet([NEAR[0]]);
    const [a, b] = await Promise.all([order(), order()]);
    const offered = [a, b].filter((d) => d.status === 'OFFERED');
    expect(offered).toHaveLength(1);
    expect(offered[0].offeredCourierId).toBe(only);
    expect([a, b].find((d) => d.status !== 'OFFERED')).toMatchObject({
      status: 'REQUESTED',
      offeredCourierId: null,
    });
  });

  it('offer timeout moves on to the next courier; stale timers are ignored', async () => {
    const [c1, c2] = await fleet(NEAR.slice(0, 2));
    const d = await order();
    await dispatch.onOfferTimeout({
      deliveryId: d.id,
      city,
      courierId: c1,
      attempt: 0,
    }); // stale attempt
    expect(await dispatch.get(d.id)).toMatchObject({ offeredCourierId: c1 });

    await dispatch.onOfferTimeout({
      deliveryId: d.id,
      city,
      courierId: c1,
      attempt: 1,
    });
    expect(await dispatch.get(d.id)).toMatchObject({
      status: 'OFFERED',
      offeredCourierId: c2,
      attempt: 2,
    });
  });

  it('location updates apply in timestamp order only; non-available couriers are not searchable', async () => {
    const [c1] = await fleet([NEAR[0]]);
    const now = Date.now();
    await couriers.report(c1, city, [{ ...NEAR[2], ts: now + 1_000 }]);
    const stale = await couriers.report(c1, city, [
      { ...NEAR[1], ts: now + 500 },
    ]); // arrived late
    expect(stale.applied).toBe(false);
    expect(
      Number(
        (await redis.client.hget(courierKey(city, c1), 'lat'))!.slice(0, 7),
      ),
    ).toBeCloseTo(NEAR[2].lat, 3);

    await couriers.setAvailability(c1, false);
    expect(await redis.client.zrange(geoKey(city), 0, -1)).toEqual([]);
  });

  it('surge rises in a cell where requests outnumber available couriers, and prices new deliveries', async () => {
    await fleet([NEAR[0]]);
    for (let i = 0; i < 3; i++) await order();
    const surge = await app.get(SurgeJob).compute(city);
    expect(surge[geohash(PICKUP.lat, PICKUP.lng, 5)]).toBe(3); // 3 requests / 1 courier

    const priced = await order();
    expect(Number(priced.surge)).toBe(3);
    expect(priced.feeCents).toBe(Math.round(499 * 3));
  });
});
