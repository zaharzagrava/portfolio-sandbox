import {
  createProduct,
  createProducts,
} from '@app/test/utils/catalog-fixtures';
import { ShopQueryService } from '@app/domains/tenancy';
import { OrderQueryService } from '@app/domains/orders';
import { EntitlementsService } from '@app/domains/billing';
import {
  createKey,
  createPublicApiKit,
  exec,
  newId,
  outboxEvents,
  rows,
  seedOrder,
  type CreatedKey,
  type PublicApiInstance,
  type PublicApiKit,
  type ShopWorld,
} from './testing/public-api-kit';
import { PublicApiProjectorModule } from './public-api-projector.module';
import { PublicApiShopLifecycleConsumer } from './infra/consumers';
import { ShopStatusChanged } from '@app/domains/tenancy';

/** Runs the rounds of a repeated test five at a time (each round uses data of its own). */
const eachRound = async (
  rounds: number,
  body: (round: number) => Promise<void>,
  size = 5,
): Promise<void> => {
  for (let from = 0; from < rounds; from += size)
    await Promise.all(
      Array.from({ length: Math.min(size, rounds - from) }, (_, k) =>
        body(from + k),
      ),
    );
};

const product = (over: Record<string, unknown> = {}) => ({
  title: 'iPhone 17',
  price: { amount: 129_900, currency: 'USD' },
  stock: 5,
  category: 'phones',
  brand: 'Acme',
  ...over,
});

describe('Public API: products, stock and orders', () => {
  let t: PublicApiKit;
  let pub: PublicApiInstance;

  beforeAll(async () => {
    t = await createPublicApiKit({
      dashboardImports: [PublicApiProjectorModule],
      // The free tier allows 10 live products and the 20-repeat races make more; the plan limit is proved in catalog's
      // product-plan-limit spec, so here the plan answer is an uncapped one.
      overrides: [
        {
          provide: EntitlementsService,
          useValue: {
            checkLimit: async () => ({
              allowed: true,
              limit: null,
              remaining: null,
            }),
          },
        },
      ],
    });
    pub = t.pub;
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const world = async (
    scopes?: string[],
  ): Promise<{ w: ShopWorld; key: CreatedKey }> => {
    const w = await t.seedWorld();
    return { w, key: await createKey(t, w, scopes ? { scopes } : {}) };
  };
  const api = (key: CreatedKey) => pub.withKey(key.key);
  const create = (
    key: CreatedKey,
    body: object = product(),
    idem: string = newId(),
  ) => api(key).post('/v1/products').set('Idempotency-Key', idem).send(body);
  const patch = (
    key: CreatedKey,
    id: string,
    body: object,
    ifMatch?: string,
  ) => {
    const req = api(key).patch(`/v1/products/${id}`);
    return (ifMatch === undefined ? req : req.set('If-Match', ifMatch)).send(
      body,
    );
  };
  const fields = (body: { errors?: { field: string }[] }) =>
    (body.errors ?? []).map((e) => e.field);

  describe('AS-37 cursor pagination', () => {
    it('S42 AS-37: three pages of 2 over 5 products with an insert in between: each product once, has_more true/true/false, last cursor null', async () => {
      const { w, key } = await world();
      const created = [] as string[];
      for (let i = 0; i < 5; i += 1)
        created.push(
          (await create(key, product({ title: `P${i}` })).expect(201)).body.id,
        );

      const first = await api(key).get('/v1/products?limit=2').expect(200);
      expect(first.body.has_more).toBe(true);
      await create(key, product({ title: 'inserted between pages' })).expect(
        201,
      );
      const second = await api(key)
        .get(`/v1/products?limit=2&cursor=${first.body.next_cursor}`)
        .expect(200);
      expect(second.body.has_more).toBe(true);
      const third = await api(key)
        .get(`/v1/products?limit=2&cursor=${second.body.next_cursor}`)
        .expect(200);
      expect(third.body.has_more).toBe(false);
      expect(third.body.next_cursor).toBeNull();

      const seen = [
        ...first.body.data,
        ...second.body.data,
        ...third.body.data,
      ].map((p: { id: string }) => p.id);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([...created].sort());
      void w;
    });

    it.each(['0', '101', 'abc', '1.5', '-1', ''])(
      'S42 AS-37: limit=%p is 400 validation_failed, never clamped',
      async (limit) => {
        const { key } = await world();
        const res = await api(key)
          .get(`/v1/products?limit=${limit}`)
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(fields(res.body)).toContain('limit');
      },
    );

    it('S42 AS-37: the default limit is 20 and 100 is accepted', async () => {
      const { w, key } = await world();
      await createProducts(t.app, w.shop, 25);
      const page = await api(key).get('/v1/products').expect(200);
      expect(page.body.data).toHaveLength(20);
      expect(page.body.has_more).toBe(true);
      await api(key).get('/v1/products?limit=100').expect(200);
    });

    it('S42 AS-37: a cursor that was not issued is 400 invalid_cursor; the cursor carries no shop id', async () => {
      const { w, key } = await world();
      await createProducts(t.app, w.shop, 3);
      for (const cursor of [
        'garbage',
        'e30',
        Buffer.from('[1,2,3]').toString('base64url'),
      ]) {
        const res = await api(key)
          .get(`/v1/products?limit=1&cursor=${cursor}`)
          .expect(400);
        expect(res.body.code).toBe('invalid_cursor');
      }
      const page = await api(key).get('/v1/products?limit=1').expect(200);
      expect(
        Buffer.from(page.body.next_cursor, 'base64url').toString(),
      ).not.toContain(w.shop.id);
    });

    it('S42 AS-16: a cursor issued to one shop is refused for another and never shows the first shop’s rows', async () => {
      const a = await world();
      const b = await world();
      await createProducts(t.app, a.w.shop, 3);
      await createProducts(t.app, b.w.shop, 3);
      const page = await api(a.key).get('/v1/products?limit=1').expect(200);
      const res = await api(b.key).get(
        `/v1/products?limit=1&cursor=${page.body.next_cursor}`,
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(page.body.data[0].id);
    });
  });

  describe('AS-38 sparse fieldsets and expand', () => {
    it('S42 AS-38: fields=title,price returns exactly {id, object, title, price}; an unknown field is 400 invalid_fields naming it', async () => {
      const { key } = await world();
      await create(key).expect(201);
      const ok = await api(key)
        .get('/v1/products?fields=title,price')
        .expect(200);
      expect(Object.keys(ok.body.data[0]).sort()).toEqual([
        'id',
        'object',
        'price',
        'title',
      ]);
      const bad = await api(key)
        .get('/v1/products?fields=title,nope')
        .expect(400);
      expect(bad.body.code).toBe('invalid_fields');
      expect(JSON.stringify(bad.body.errors)).toContain('nope');
    });

    it('S42 AS-38: expand=shop adds the acting shop of every item with one batch lookup for a page of 100', async () => {
      const { w, key } = await world();
      await createProducts(t.app, w.shop, 100);
      await api(key).get('/v1/products?limit=1').expect(200); // warm the key and status entries
      const spy = jest.spyOn(pub.app.get(ShopQueryService), 'getShopsByIds');
      try {
        const res = await api(key)
          .get('/v1/products?limit=100&expand=shop')
          .expect(200);
        expect(res.body.data).toHaveLength(100);
        expect(spy).toHaveBeenCalledTimes(1);
        for (const item of res.body.data) {
          expect(Object.keys(item.shop).sort()).toEqual(['id', 'name', 'slug']);
          expect(item.shop.id).toBe(w.shop.id);
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('S42 AS-38: fields and expand combine', async () => {
      const { w, key } = await world();
      await create(key).expect(201);
      const res = await api(key)
        .get('/v1/products?fields=title&expand=shop')
        .expect(200);
      expect(Object.keys(res.body.data[0]).sort()).toEqual([
        'id',
        'object',
        'shop',
        'title',
      ]);
      expect(res.body.data[0].shop.id).toBe(w.shop.id);
    });

    it.each(['orders', 'shop.owner', 'shop,orders', 'shop,shop,shop,shop'])(
      'S42 AS-38: expand=%s is 400 invalid_expand',
      async (expand) => {
        const { key } = await world();
        const res = await api(key)
          .get(`/v1/products?expand=${expand}`)
          .expect(400);
        expect(res.body.code).toBe('invalid_expand');
      },
    );
  });

  describe('AS-39 create a product', () => {
    it('S42 AS-39: 201 with Location and ETag, version 1, created through the catalog with the key’s creator, one product event', async () => {
      const { w, key } = await world();
      const res = await create(key).expect(201);
      expect(res.headers.location).toBe(`/v1/products/${res.body.id}`);
      expect(res.headers.etag).toBe('"1"');
      expect(res.body).toMatchObject({
        version: 1,
        title: 'iPhone 17',
        price: { amount: 129_900, currency: 'USD' },
        stock: 5,
        brand: 'Acme',
        status: 'active',
      });
      const [stored] = await rows<{ createdBy: string; shopId: string }>(
        t.app,
        `SELECT "createdBy", "shopId" FROM "Product" WHERE id = :id`,
        { id: res.body.id },
      );
      expect(stored).toEqual({ createdBy: w.owner.id, shopId: w.shop.id });
      const events = await outboxEvents(t.app, 'catalog.product_created', {
        aggregateId: res.body.id,
      });
      expect(events).toHaveLength(1);
      const total = await api(key).get('/v1/products').expect(200);
      expect(total.body.data).toHaveLength(1);
    });

    it.each<[string, Record<string, unknown>, string]>([
      [
        'price.amount 0',
        { price: { amount: 0, currency: 'USD' } },
        'price.amount',
      ],
      [
        'a negative price',
        { price: { amount: -5, currency: 'USD' } },
        'price.amount',
      ],
      [
        'a fractional price',
        { price: { amount: 10.5, currency: 'USD' } },
        'price.amount',
      ],
      [
        'a price above the maximum',
        { price: { amount: 10_000_000_001, currency: 'USD' } },
        'price.amount',
      ],
      [
        'another currency',
        { price: { amount: 100, currency: 'EUR' } },
        'price.currency',
      ],
      ['an empty title', { title: '' }, 'title'],
      ['a title over 200', { title: 't'.repeat(201) }, 'title'],
      ['a negative stock', { stock: -1 }, 'stock'],
      ['a fractional stock', { stock: 1.5 }, 'stock'],
      ['a missing category', { category: undefined }, 'category'],
      ['a missing brand', { brand: undefined }, 'brand'],
      ['an extra property', { sellerId: newId() }, 'sellerId'],
    ])(
      'S42 AS-39: %s is 400 validation_failed naming %s and nothing is created',
      async (_n, patch, field) => {
        const { w, key } = await world();
        const res = await create(key, { ...product(), ...patch });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(fields(res.body)).toContain(field);
        const [{ n }] = await rows<{ n: number }>(
          t.app,
          `SELECT count(*)::int AS n FROM "Product" WHERE "shopId" = :id`,
          { id: w.shop.id },
        );
        expect(n).toBe(0);
      },
    );

    it('S42 AS-39: a key of a suspended shop is 403 shop_suspended', async () => {
      const { w, key } = await world();
      await exec(
        t.app,
        `UPDATE "Shop" SET status = 'SUSPENDED' WHERE id = :id`,
        { id: w.shop.id },
      );
      await t.app.get(PublicApiShopLifecycleConsumer).project([
        ShopStatusChanged.create(w.shop.id, 3, {
          shopId: w.shop.id,
          from: 'ACTIVE',
          to: 'SUSPENDED',
          shopVersion: 3,
        }),
      ]);
      const res = await create(key);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('shop_suspended');
    });
  });

  describe('AS-40 update with optimistic concurrency', () => {
    const atVersion = async (key: CreatedKey, version: number) => {
      const created = await create(key).expect(201);
      let current = 1;
      while (current < version) {
        const res = await patch(
          key,
          created.body.id,
          { title: `t${current}` },
          `"${current}"`,
        ).expect(200);
        current = res.body.version;
      }
      return created.body.id as string;
    };

    it('S42 AS-40: If-Match with the current version updates and returns the next one; ETag is on every product response', async () => {
      const { key } = await world();
      const id = await atVersion(key, 7);
      const read = await api(key).get(`/v1/products/${id}`).expect(200);
      expect(read.headers.etag).toBe('"7"');
      const res = await patch(key, id, { title: 'renamed' }, '"7"').expect(200);
      expect(res.body).toMatchObject({ version: 8, title: 'renamed' });
      expect(res.headers.etag).toBe('"8"');
    });

    it('S42 AS-40: no If-Match is 428 precondition_required, a stale one 412 version_conflict naming the current version, and nothing changes', async () => {
      const { key } = await world();
      const id = await atVersion(key, 7);
      const missing = await patch(key, id, { title: 'x' }).expect(428);
      expect(missing.body.code).toBe('precondition_required');
      const stale = await patch(key, id, { title: 'x' }, '"6"').expect(412);
      expect(stale.body.code).toBe('version_conflict');
      expect(stale.body.detail).toContain('7');
      const [stored] = await rows<{ version: number; title: string }>(
        t.app,
        `SELECT version, title FROM "Product" WHERE id = :id`,
        { id },
      );
      expect(stored.version).toBe(7);
      expect(stored.title).not.toBe('x');
    });

    it('S42 AS-40: two parallel PATCH with the same If-Match give one 200 and one 412, and the stored version is the next one (20 repeats)', async () => {
      const { key } = await world();
      await eachRound(20, async () => {
        const id = await atVersion(key, 8);
        const results = await Promise.all([
          patch(key, id, { title: 'a' }, '"8"'),
          patch(key, id, { title: 'b' }, '"8"'),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
        const [stored] = await rows<{ version: number }>(
          t.app,
          `SELECT version FROM "Product" WHERE id = :id`,
          { id },
        );
        expect(stored.version).toBe(9);
      });
    });

    it('S42 AS-40: an archived product is 409 product_archived; an empty body or one with no changeable field is 400', async () => {
      const { key } = await world();
      const id = await atVersion(key, 2);
      const empty = await patch(key, id, {}, '"2"').expect(400);
      expect(empty.body.code).toBe('validation_failed');
      await patch(key, id, { id: newId() }, '"2"').expect(400);
      await exec(
        t.app,
        `UPDATE "Product" SET status = 'ARCHIVED' WHERE id = :id`,
        { id },
      );
      const archived = await patch(key, id, { title: 'x' }, '"2"').expect(409);
      expect(archived.body.code).toBe('product_archived');
    });

    it('S42 AS-40: price and stock follow the create rules, and another shop’s product is 404', async () => {
      const a = await world();
      const b = await world();
      const id = await atVersion(a.key, 1);
      const bad = await patch(a.key, id, { price: 129_900 }, '"1"').expect(400);
      expect(fields(bad.body)).toContain('price');
      await patch(
        a.key,
        id,
        { price: { amount: 0, currency: 'USD' } },
        '"1"',
      ).expect(400);
      await patch(a.key, id, { stock: -1 }, '"1"').expect(400);
      const ok = await patch(
        a.key,
        id,
        { price: { amount: 500, currency: 'USD' }, stock: 9 },
        '"1"',
      ).expect(200);
      expect(ok.body).toMatchObject({
        price: { amount: 500, currency: 'USD' },
        stock: 9,
        version: 2,
      });
      const foreign = await patch(b.key, id, { title: 'hijack' }, '"2"').expect(
        404,
      );
      expect(foreign.body.code).toBe('resource_missing');
    });
  });

  describe('AS-41 stock read', () => {
    it('S42 AS-41: GET /v1/stock/:id and the deprecated route both read the stock', async () => {
      const { key } = await world();
      const { body } = await create(key).expect(201);
      const stock = await api(key).get(`/v1/stock/${body.id}`).expect(200);
      expect(stock.body).toMatchObject({
        object: 'stock',
        product_id: body.id,
        stock: 5,
        livemode: true,
      });
      expect(Number.isNaN(Date.parse(stock.body.updated_at))).toBe(false);
      const old = await api(key)
        .get(`/v1/products/${body.id}/stock`)
        .expect(200);
      expect(old.body).toMatchObject({ product_id: body.id, stock: 5 });
      expect(old.headers.deprecation).toBe('@1790812800');
    });

    it('S42 AS-41: both need products:read', async () => {
      const { key } = await world(['orders:read']);
      await api(key).get(`/v1/stock/${newId()}`).expect(403);
      await api(key).get(`/v1/products/${newId()}/stock`).expect(403);
    });
  });

  describe('AS-42 orders: the shop’s slice only', () => {
    const twoShopOrder = async () => {
      const a = await world();
      const b = await world();
      const buyer = await t.newUser();
      const pa = await createProduct(t.app, a.w.shop, { priceMinor: 500 });
      const pb = await createProduct(t.app, b.w.shop, { priceMinor: 700 });
      const order = await seedOrder(t.app, {
        buyerId: buyer.id,
        createdAt: new Date(t.clock.now().getTime() - 3_600_000),
        lines: [
          {
            productId: pa.id,
            shopId: a.w.shop.id,
            quantity: 2,
            unitPriceMinor: 500,
          },
          {
            productId: pb.id,
            shopId: b.w.shop.id,
            quantity: 1,
            unitPriceMinor: 700,
          },
        ],
      });
      return { a, b, buyer, pa, pb, order };
    };

    it('S42 AS-42: only the key’s shop’s part appears, with no buyer data anywhere', async () => {
      const { a, b, buyer, pb, order } = await twoShopOrder();
      const list = await api(a.key).get('/v1/orders').expect(200);
      expect(list.body.data).toHaveLength(1);
      const [item] = list.body.data;
      expect(item).toMatchObject({
        id: order.shopOrders.get(a.w.shop.id),
        object: 'order',
        livemode: true,
        total: { amount: 1_000, currency: 'USD' },
        lines: [{ quantity: 2, unit_price: { amount: 500, currency: 'USD' } }],
      });
      const wire = JSON.stringify(list.body);
      for (const forbidden of [
        buyer.id,
        buyer.email,
        pb.id,
        b.w.shop.id,
        'buyer',
        '1700',
      ])
        expect(wire).not.toContain(forbidden);
      const one = await api(a.key).get(`/v1/orders/${item.id}`).expect(200);
      expect(one.body).toEqual(item);
      const foreign = await api(a.key)
        .get(`/v1/orders/${order.shopOrders.get(b.w.shop.id)}`)
        .expect(404);
      expect(foreign.body.code).toBe('resource_missing');
    });

    it('S42 AS-42: ?status= filters by a known status, an unknown one is 400, pages go newest first, lines come from one call per page', async () => {
      const { a, pa } = await twoShopOrder();
      const buyer = await t.newUser();
      const base = t.clock.now().getTime();
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const o = await seedOrder(t.app, {
          buyerId: buyer.id,
          status: i < 2 ? 'PAID' : 'PENDING',
          createdAt: new Date(base + (i + 1) * 1_000),
          lines: [
            {
              productId: pa.id,
              shopId: a.w.shop.id,
              quantity: 1,
              unitPriceMinor: 500,
            },
          ],
        });
        ids.push(o.shopOrders.get(a.w.shop.id)!);
      }
      const paid = await api(a.key).get('/v1/orders?status=PAID').expect(200);
      expect(paid.body.data.map((o: { id: string }) => o.id).sort()).toEqual(
        [ids[0], ids[1]].sort(),
      );
      expect(
        paid.body.data.every((o: { status: string }) => o.status === 'PAID'),
      ).toBe(true);
      const bad = await api(a.key).get('/v1/orders?status=BOGUS').expect(400);
      expect(bad.body.code).toBe('validation_failed');

      const first = await api(a.key).get('/v1/orders?limit=2').expect(200);
      expect(first.body.data.map((o: { id: string }) => o.id)).toEqual([
        ids[3],
        ids[2],
      ]);
      const second = await api(a.key)
        .get(`/v1/orders?limit=2&cursor=${first.body.next_cursor}`)
        .expect(200);
      expect(
        second.body.data.map((o: { id: string }) => o.id).slice(0, 2),
      ).toEqual([ids[1], ids[0]]);

      const spy = jest.spyOn(
        pub.app.get(OrderQueryService),
        'getOrdersForShop',
      );
      try {
        await api(a.key).get('/v1/orders?limit=3').expect(200);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
