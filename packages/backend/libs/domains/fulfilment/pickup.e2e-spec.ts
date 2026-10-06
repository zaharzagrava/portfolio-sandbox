import { INestApplication, Module } from '@nestjs/common';
import { getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { ShopModel as Shop } from '@app/domains/tenancy';
import Outbox from '@app/infrastructure/outbox/outbox.model';
import { ProductModel as Product } from '@app/domains/catalog';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PickupModule } from './pickup.module';
import { PickupService } from './application/pickup.service';
import { AvailabilityIndex, AVAILABILITY_INDEX } from './infra/availability-index';
import { PickupAvailabilityProjector } from './infra/pickup-availability.projector';
import { PickupStockChanged } from './application/events/pickup-events';

@Module({ imports: [ElasticsearchModule, SequelizeModule.forFeature([Product, Shop, Outbox])], providers: [PickupAvailabilityProjector] })
class ProjectorSpecModule {}

// Berlin Alexanderplatz and points ~3 km / ~12 km away.
const ALEX = { lat: 52.5219, lng: 13.4132 };
const KREUZBERG = { lat: 52.4986, lng: 13.3911 };
const SPANDAU = { lat: 52.5354, lng: 13.2003 };

/** SD-13 against real PostGIS + Elasticsearch. */
describe('Pickup near me (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let pickup: PickupService;
  let projector: PickupAvailabilityProjector;
  let availability: AvailabilityIndex;
  let shopId: string;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([PickupModule, ProjectorSpecModule, SeedsModule]);
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    pickup = app.get(PickupService);
    projector = app.get(PickupAvailabilityProjector);
    availability = app.get(AvailabilityIndex);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    await app.get(ElasticsearchService).getClient().deleteByQuery({ index: AVAILABILITY_INDEX, query: { match_all: {} }, refresh: true }).catch(() => undefined);
    shopId = (await app.get<typeof Shop>(getModelToken(Shop)).create({ name: 'Electro', slug: `e-${v4().slice(0, 8)}` })).id;
  });

  /** Plays the outbox → Kafka hop: feeds the projector the envelopes the transaction recorded. */
  const project = async () => {
    const rows = await app.get<typeof Outbox>(getModelToken(Outbox)).findAll({ where: { topic: PickupStockChanged.topic } });
    await projector.project(rows.map((r) => r.payload as EventEnvelope));
    await app.get(ElasticsearchService).getClient().indices.refresh({ index: AVAILABILITY_INDEX });
  };

  it('"AirPods within 5 km": found via the 3 km point, not within 2 km; zero-stock points excluded', async () => {
    const [airpods] = await seeds.createTreelike([{ __type__: TableName.Product, title: 'AirPods Pro 3', shopId }]);
    const kreuzberg = await pickup.createPoint(shopId, { name: 'Kreuzberg', address: 'x', ...KREUZBERG });
    const spandau = await pickup.createPoint(shopId, { name: 'Spandau', address: 'y', ...SPANDAU });
    await pickup.setStock(shopId, kreuzberg.id, airpods.id, 4);
    await pickup.setStock(shopId, spandau.id, airpods.id, 0);
    await project();

    const within5 = await availability.searchNear({ q: 'airpods', ...ALEX, radiusKm: 5 });
    expect(within5).toHaveLength(1);
    expect(within5[0].nearest).toMatchObject({ pickupPointId: kreuzberg.id, quantity: 4 });
    expect(within5[0].nearest.distanceM).toBeGreaterThan(2_000);
    expect(await availability.searchNear({ q: 'airpods', ...ALEX, radiusKm: 2 })).toHaveLength(0);
    expect(await availability.searchNear({ q: 'airpods', ...ALEX, radiusKm: 20 })).toHaveLength(1); // Spandau has 0 → still one product
  });

  it('PostGIS radius query is exact and ordered by distance', async () => {
    const near = await pickup.createPoint(shopId, { name: 'Kreuzberg', address: 'x', ...KREUZBERG });
    const far = await pickup.createPoint(shopId, { name: 'Spandau', address: 'y', ...SPANDAU });
    const points = await pickup.near(ALEX.lat, ALEX.lng, 20);
    expect(points.map((p) => p.id)).toEqual([near.id, far.id]);
    expect(points[0].distanceM).toBeLessThan(points[1].distanceM);
    expect((await pickup.near(ALEX.lat, ALEX.lng, 5)).map((p) => p.id)).toEqual([near.id]);
  });

  it('out-of-order stock events never resurrect sold-out availability (external versions)', async () => {
    const [p] = await seeds.createTreelike([{ __type__: TableName.Product, title: 'iPad', shopId }]);
    const point = await pickup.createPoint(shopId, { name: 'K', address: 'x', ...KREUZBERG });
    await pickup.setStock(shopId, point.id, p.id, 5); // v1
    await pickup.setStock(shopId, point.id, p.id, 0); // v2
    const rows = await app.get<typeof Outbox>(getModelToken(Outbox)).findAll({ where: { topic: PickupStockChanged.topic }, order: [['createdAt', 'ASC']] });
    const [v1, v2] = rows.map((r) => r.payload as EventEnvelope);

    await projector.project([v2]);
    await projector.project([v1]); // late delivery of the older event
    await app.get(ElasticsearchService).getClient().indices.refresh({ index: AVAILABILITY_INDEX });
    expect(await availability.searchNear({ q: 'ipad', ...ALEX, radiusKm: 10 })).toHaveLength(0);
  });
});
