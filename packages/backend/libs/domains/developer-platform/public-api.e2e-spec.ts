import { INestApplication } from '@nestjs/common';
import {
  getConnectionToken,
  getModelToken,
  SequelizeModule,
} from '@nestjs/sequelize';
import { Module } from '@nestjs/common';
import { Sequelize } from 'sequelize';
import request from 'supertest';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { PublicApiModule } from './public-api.module';
import { ApiKeysService } from './application/api-keys.service';
import type { ApiScope } from './domain/api-key-format';

@Module({ imports: [PublicApiModule, SequelizeModule.forFeature([Shop])] })
class SpecModule {}

const ALL: ApiScope[] = [
  'products:read',
  'products:write',
  'orders:read',
  'stock:write',
];

/** SD-07 against real Postgres + Redis, through the HTTP surface (no global prefix, like apps/public-api). */
describe('Public API (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let keys: ApiKeysService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [SpecModule, RateLimitModule, SeedsModule],
      { stores: ['redis', 'sqs'] },
    );
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    keys = app.get(ApiKeysService);
    jest
      .spyOn(app.get(KafkaProducerService), 'send')
      .mockResolvedValue(undefined as never);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
  });

  const shopWithKey = async (scopes: ApiScope[] = ALL, livemode = true) => {
    const [owner] = await seeds.createTreelike([{ __type__: TableName.User }]);
    const shop = await app
      .get<typeof Shop>(getModelToken(Shop))
      .create({ name: 'ERP Shop', slug: `erp-${v4().slice(0, 8)}` });
    const key = await keys.create(shop.id, owner.id, 'erp', scopes, livemode);
    return {
      shopId: shop.id,
      ownerId: owner.id as string,
      key: key.key,
      keyId: key.id,
      auth: { Authorization: `Bearer ${key.key}` },
    };
  };

  const createProduct = (
    auth: Record<string, string>,
    title = 'iPhone 17',
    idem = v4(),
  ) =>
    http()
      .post('/v1/products')
      .set(auth)
      .set('Idempotency-Key', idem)
      .send({ title, price: 129_900, stock: 5, category: 'phones' });

  it("tenant comes from the key: another shop's product is a 404; revoked keys stop working immediately", async () => {
    const a = await shopWithKey();
    const b = await shopWithKey();
    const product = (await createProduct(a.auth).expect(201)).body;

    await http().get(`/v1/products/${product.id}`).set(a.auth).expect(200);
    await http().get(`/v1/products/${product.id}`).set(b.auth).expect(404);

    await keys.revoke(a.shopId, a.keyId);
    await http().get(`/v1/products/${product.id}`).set(a.auth).expect(401);
    await http()
      .get('/v1/products')
      .set({ Authorization: 'Bearer sk_live_nope' })
      .expect(401);
  });

  it('scopes are enforced per endpoint', async () => {
    const readOnly = await shopWithKey(['products:read']);
    await createProduct(readOnly.auth).expect(403);
    await http().get('/v1/products').set(readOnly.auth).expect(200);
  });

  it("date versions: latest shape by default, older shape by header or by the shop's pinned version", async () => {
    const a = await shopWithKey();
    const { id } = (await createProduct(a.auth).expect(201)).body;

    const latest = await http()
      .get(`/v1/products/${id}`)
      .set(a.auth)
      .expect(200);
    expect(latest.headers['marketplace-version']).toBe('2026-10-01');
    expect(latest.body).toMatchObject({
      price: { amount: 129_900, currency: 'usd' },
      stock: 5,
    });

    const old = await http()
      .get(`/v1/products/${id}`)
      .set(a.auth)
      .set('Marketplace-Version', '2026-01-15')
      .expect(200);
    expect(old.body).toMatchObject({ price: 129_900, quantity: 5 });
    expect(old.body.stock).toBeUndefined();

    await app
      .get<Sequelize>(getConnectionToken())
      .query(
        `INSERT INTO "ShopApiSettings" ("shopId", "pinnedVersion") VALUES (:shopId, '2026-01-15')`,
        { replacements: { shopId: a.shopId } },
      );
    await app.get(CacheService).invalidate([`api:pinned:${a.shopId}`]); // what PUT /developers/api-version does
    const list = await http()
      .get('/v1/products?fields=title,price')
      .set(a.auth)
      .expect(200);
    expect(list.headers['marketplace-version']).toBe('2026-01-15');
    expect(list.body.data[0]).toEqual({
      id,
      object: 'product',
      title: 'iPhone 17',
      price: 129_900,
    });

    await http()
      .get('/v1/products')
      .set(a.auth)
      .set('Marketplace-Version', '1999-01-01')
      .expect(400);
  });

  it('deprecated routes announce Deprecation, Sunset and the successor', async () => {
    const a = await shopWithKey();
    const { id } = (await createProduct(a.auth).expect(201)).body;
    const res = await http()
      .get(`/v1/products/${id}/stock`)
      .set(a.auth)
      .expect(200);
    expect(res.headers.deprecation).toMatch(/^@\d+$/);
    expect(res.headers.sunset).toBe(new Date('2027-04-01').toUTCString());
    expect(res.headers.link).toContain(
      '</v1/stock/{productId}>; rel="successor-version"',
    );
    expect(
      (await http().get(`/v1/stock/${id}`).set(a.auth).expect(200)).headers
        .deprecation,
    ).toBeUndefined();
  });

  it('Idempotency-Key: retries replay the first response; reuse with a different body is rejected', async () => {
    const a = await shopWithKey();
    const idem = v4();
    const first = await createProduct(a.auth, 'AirPods', idem).expect(201);
    const retry = await createProduct(a.auth, 'AirPods', idem).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    await createProduct(a.auth, 'Something else', idem).expect(422);
    expect(
      (await http().get('/v1/products').set(a.auth)).body.data,
    ).toHaveLength(1);
  });

  it('test keys act on an isolated sandbox shop', async () => {
    const live = await shopWithKey();
    const test = await keys.create(live.shopId, live.ownerId, 'ci', ALL, false);
    const testAuth = { Authorization: `Bearer ${test.key}` };
    expect(test.key.startsWith('sk_test_')).toBe(true);

    await createProduct(testAuth, 'Sandbox phone').expect(201);
    expect(
      (await http().get('/v1/products').set(testAuth)).body.data.map(
        (p: { title: string }) => p.title,
      ),
    ).toEqual(['Sandbox phone']);
    expect((await http().get('/v1/products').set(live.auth)).body.data).toEqual(
      [],
    );
  });

  it("bulk stock: small batches apply synchronously, only for the key's own products; cursor pagination is stable", async () => {
    const a = await shopWithKey();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push((await createProduct(a.auth, `P${i}`).expect(201)).body.id);
    const foreign = (
      await createProduct((await shopWithKey()).auth, 'Foreign').expect(201)
    ).body.id;

    const res = await http()
      .post('/v1/stock/bulk')
      .set(a.auth)
      .send({
        items: [
          ...ids.map((productId) => ({ productId, stock: 42 })),
          { productId: foreign, stock: 0 },
        ],
      })
      .expect(202);
    expect(res.body).toMatchObject({
      status: 'succeeded',
      updated: 3,
      not_found: 1,
    });

    const page1 = (
      await http().get('/v1/products?limit=2').set(a.auth).expect(200)
    ).body;
    const page2 = (
      await http()
        .get(`/v1/products?limit=2&cursor=${page1.next_cursor}`)
        .set(a.auth)
        .expect(200)
    ).body;
    expect(
      [...page1.data, ...page2.data].map((p: { id: string }) => p.id),
    ).toEqual([...ids].sort());
    expect(page2.has_more).toBe(false);
    expect(page1.data.every((p: { stock: number }) => p.stock === 42)).toBe(
      true,
    );
  });
});
