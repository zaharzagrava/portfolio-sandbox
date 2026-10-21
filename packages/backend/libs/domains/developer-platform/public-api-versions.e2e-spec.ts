import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  addShopMember,
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
import { DEPRECATED_ROUTES, VERSION_REGISTRY } from './domain/version-registry';
import type { VersionEntry } from './domain/version-registry';

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

const LATEST = '2026-10-01';
const OLD = '2026-01-15';
const DEPRECATION_HEADERS = {
  deprecation: '@1790812800',
  sunset: 'Thu, 01 Apr 2027 00:00:00 GMT',
};
const registry = VERSION_REGISTRY as unknown as VersionEntry[];
const routeEntry = DEPRECATED_ROUTES['GET /v1/products/:id/stock'];

const product = (over: Record<string, unknown> = {}) => ({
  title: 'iPhone 17',
  price: { amount: 129_900, currency: 'USD' },
  stock: 5,
  category: 'phones',
  brand: 'Acme',
  ...over,
});

describe('Public API: date-pinned versions and deprecation', () => {
  let t: PublicApiKit;
  let pub2: PublicApiInstance;

  beforeAll(async () => {
    t = await createPublicApiKit();
    pub2 = await t.publicInstance();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const world = async (): Promise<{ w: ShopWorld; key: CreatedKey }> => {
    const w = await t.seedWorld();
    return { w, key: await createKey(t, w) };
  };
  const api = (key: CreatedKey, inst: PublicApiInstance = t.pub) =>
    inst.withKey(key.key);
  const create = (
    key: CreatedKey,
    body: object = product(),
    version?: string,
  ) => {
    const req = api(key).post('/v1/products').set('Idempotency-Key', newId());
    return (version ? req.set('Marketplace-Version', version) : req).send(body);
  };
  const pins = (shopId: string) =>
    rows<{ pinnedVersion: string }>(
      t.app,
      `SELECT "pinnedVersion" FROM "ShopApiSettings" WHERE "shopId" = :shopId`,
      { shopId },
    );
  const VERSION = (shopId: string) =>
    `/api/shops/${shopId}/developers/api-version`;

  describe('AS-26 the first key pins the shop', () => {
    it('S42 AS-26: two concurrent first-key creations leave exactly one pin row, on the latest version (20 repeats)', async () => {
      await eachRound(20, async () => {
        const w = await t.seedWorld();
        const body = {
          name: 'ERP',
          scopes: ['products:read'],
          livemode: false,
        };
        const results = await Promise.all(
          [0, 1].map(() =>
            t
              .as(w.ownerMfa)
              .post(`/api/shops/${w.shop.id}/developers/keys`)
              .send(body),
          ),
        );
        expect(results.map((r) => r.status)).toEqual([201, 201]);
        expect(await pins(w.shop.id)).toEqual([{ pinnedVersion: LATEST }]);
        const events = await outboxEvents(
          t.app,
          'developerplatform.api_version_pinned',
          { shopId: w.shop.id },
        );
        expect(events).toHaveLength(1);
        expect(events[0].payload).toMatchObject({
          version: LATEST,
          previousVersion: null,
        });
      });
    });

    it('S42 AS-26: a newly registered version does not move a pinned shop; a shop created after it is pinned to it', async () => {
      const { w, key } = await world();
      const fake: VersionEntry = {
        version: '2027-03-01',
        lifecycle: { status: 'supported' },
        change: {
          description: 'no shape change',
          downgrade: { product: (r) => r, order: (r) => r },
          upgradeProductWrite: (b) => b,
        },
      };
      registry.push(fake);
      try {
        const old = await api(key).get('/v1/products');
        expect(old.status).toBe(200);
        expect(old.headers['marketplace-version']).toBe(LATEST);
        expect(await pins(w.shop.id)).toEqual([{ pinnedVersion: LATEST }]);

        const w2 = await t.seedWorld();
        const key2 = await createKey(t, w2);
        const fresh = await api(key2).get('/v1/products');
        expect(fresh.headers['marketplace-version']).toBe('2027-03-01');
        expect(await pins(w2.shop.id)).toEqual([
          { pinnedVersion: '2027-03-01' },
        ]);
      } finally {
        registry.pop();
      }
    });

    it('S42 AS-26: a shop that has no pin is pinned to the latest at its first authenticated call, once', async () => {
      const { w, key } = await world();
      await exec(t.app, `DELETE FROM "ShopApiSettings" WHERE "shopId" = :id`, {
        id: w.shop.id,
      });
      const first = await api(key).get('/v1/products');
      expect(first.headers['marketplace-version']).toBe(LATEST);
      expect(await pins(w.shop.id)).toEqual([{ pinnedVersion: LATEST }]);
      await Promise.all([
        api(key).get('/v1/products'),
        api(key, pub2).get('/v1/products'),
      ]);
      expect(await pins(w.shop.id)).toHaveLength(1);
    });
  });

  describe('AS-27 resolution order and echo', () => {
    it('S42 AS-27: the header wins for that request only, is echoed, and never changes the stored pin', async () => {
      const { w, key } = await world();
      await create(key).expect(201);
      const old = await api(key)
        .get('/v1/products')
        .set('Marketplace-Version', OLD)
        .expect(200);
      expect(old.headers['marketplace-version']).toBe(OLD);
      expect(old.body.data[0].price).toBe(129_900);
      const none = await api(key).get('/v1/products').expect(200);
      expect(none.headers['marketplace-version']).toBe(LATEST);
      expect(none.body.data[0].price).toEqual({
        amount: 129_900,
        currency: 'USD',
      });
      expect(await pins(w.shop.id)).toEqual([{ pinnedVersion: LATEST }]);
    });

    it.each(['1999-01-01', 'latest', '2026-1-1', '2026-10-01, 2026-01-15', ''])(
      'S42 AS-27: Marketplace-Version %p is 400 invalid_version listing the supported versions, and no work is done',
      async (value) => {
        const { w, key } = await world();
        const res = await api(key)
          .post('/v1/products')
          .set('Idempotency-Key', newId())
          .set('Marketplace-Version', value)
          .send(product());
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_version');
        expect(res.body.supported).toEqual([OLD, LATEST]);
        const [{ n }] = await rows<{ n: number }>(
          t.app,
          `SELECT count(*)::int AS n FROM "Product" WHERE "shopId" = :id`,
          { id: w.shop.id },
        );
        expect(n).toBe(0);
      },
    );
  });

  describe('AS-28 responses are downgraded by transformers', () => {
    it('S42 AS-28: the product and the order have the documented shape at the latest version and the old one at 2026-01-15', async () => {
      const { w, key } = await world();
      const buyer = await t.newUser();
      const created = await create(key).expect(201);
      await seedOrder(t.app, {
        buyerId: buyer.id,
        lines: [
          {
            productId: created.body.id,
            shopId: w.shop.id,
            quantity: 1,
            unitPriceMinor: 129_900,
          },
        ],
      });

      const latest = await api(key)
        .get(`/v1/products/${created.body.id}`)
        .expect(200);
      expect(Object.keys(latest.body).sort()).toEqual(
        [
          'id',
          'object',
          'livemode',
          'title',
          'description',
          'price',
          'stock',
          'category',
          'brand',
          'status',
          'version',
          'created_at',
          'updated_at',
        ].sort(),
      );
      expect(latest.body).toMatchObject({
        object: 'product',
        livemode: true,
        price: { amount: 129_900, currency: 'USD' },
        stock: 5,
        status: 'active',
        version: 1,
      });

      const old = await api(key)
        .get(`/v1/products/${created.body.id}`)
        .set('Marketplace-Version', OLD)
        .expect(200);
      expect(old.body.price).toBe(129_900);
      expect(old.body.quantity).toBe(5);
      expect(old.body).not.toHaveProperty('stock');
      for (const field of ['livemode', 'status', 'version'])
        expect(old.body).toHaveProperty(field);

      const orders = await api(key).get('/v1/orders').expect(200);
      expect(orders.body.data[0]).toMatchObject({
        object: 'order',
        livemode: true,
        total: { amount: 129_900, currency: 'USD' },
        lines: [
          {
            product_id: created.body.id,
            quantity: 1,
            unit_price: { amount: 129_900, currency: 'USD' },
          },
        ],
      });
      const oldOrders = await api(key)
        .get('/v1/orders')
        .set('Marketplace-Version', OLD)
        .expect(200);
      expect(oldOrders.body.data[0]).toMatchObject({
        total: 129_900,
        currency: 'USD',
        lines: [{ unit_price: 129_900 }],
      });
      expect(oldOrders.body).toMatchObject({
        object: 'list',
        has_more: false,
        next_cursor: null,
      });

      const oldList = await api(key)
        .get('/v1/products')
        .set('Marketplace-Version', OLD)
        .expect(200);
      expect(oldList.body.data[0]).toMatchObject({
        price: 129_900,
        quantity: 5,
      });
      expect(oldList.body).toMatchObject({
        object: 'list',
        has_more: false,
        next_cursor: null,
      });
    });
  });

  describe('AS-29 requests are upgraded; fields speak the requested version', () => {
    it('S42 AS-29: an old-version create is upgraded to the latest shape and stores the same product', async () => {
      const { key } = await world();
      const old = await create(
        key,
        { title: 'Old', price: 129_900, quantity: 5, category: 'phones' },
        OLD,
      ).expect(201);
      expect(old.body).toMatchObject({
        price: 129_900,
        quantity: 5,
        brand: 'Unbranded',
      });
      const [stored] = await rows<{
        priceMinor: number;
        quantity: number;
        currency: string;
      }>(
        t.app,
        `SELECT "priceMinor", quantity, currency FROM "Product" WHERE id = :id`,
        { id: old.body.id },
      );
      const latest = await create(key, product({ title: 'New' })).expect(201);
      const [reference] = await rows<{
        priceMinor: number;
        quantity: number;
        currency: string;
      }>(
        t.app,
        `SELECT "priceMinor", quantity, currency FROM "Product" WHERE id = :id`,
        { id: latest.body.id },
      );
      expect(stored).toEqual(reference);
    });

    it('S42 AS-29: at the latest version a bare price and the old quantity name are refused', async () => {
      const { key } = await world();
      const bare = await create(key, product({ price: 129_900 })).expect(400);
      expect(bare.body.code).toBe('validation_failed');
      expect(bare.body.errors.map((e: { field: string }) => e.field)).toContain(
        'price',
      );
      const quantity = await create(key, { ...product(), quantity: 5 }).expect(
        400,
      );
      expect(
        quantity.body.errors.map((e: { field: string }) => e.field),
      ).toContain('quantity');
    });

    it('S42 AS-29: fields are the names of the requested version', async () => {
      const { key } = await world();
      await create(key).expect(201);
      const old = await api(key)
        .get('/v1/products?fields=title,quantity')
        .set('Marketplace-Version', OLD)
        .expect(200);
      expect(Object.keys(old.body.data[0]).sort()).toEqual([
        'id',
        'object',
        'quantity',
        'title',
      ]);
      const latest = await api(key)
        .get('/v1/products?fields=title,quantity')
        .expect(400);
      expect(latest.body.code).toBe('invalid_fields');
      expect(JSON.stringify(latest.body.errors)).toContain('quantity');
    });
  });

  describe('AS-30 pin from the dashboard', () => {
    it('S42 AS-30: PUT changes the pin, GET reads it, every instance follows within the bound, one event per change', async () => {
      const { w, key } = await world();
      await create(key).expect(201);
      const put = await t
        .as(w.owner)
        .put(VERSION(w.shop.id))
        .send({ version: OLD })
        .expect(200);
      expect(put.body).toMatchObject({ version: OLD, previousVersion: LATEST });
      expect(Date.parse(put.body.pinnedAt)).toBe(t.clock.now().getTime());

      for (const inst of [t.pub, pub2]) {
        const res = await api(key, inst).get('/v1/products').expect(200);
        expect(res.headers['marketplace-version']).toBe(OLD);
        expect(res.body.data[0].price).toBe(129_900);
      }
      const state = await t.as(w.owner).get(VERSION(w.shop.id)).expect(200);
      expect(state.body).toMatchObject({ version: OLD, latest: LATEST });
      expect(
        state.body.supported.map((s: { version: string }) => s.version),
      ).toEqual([OLD, LATEST]);

      // the same version again: 200, nothing changes, no event
      await t
        .as(w.owner)
        .put(VERSION(w.shop.id))
        .send({ version: OLD })
        .expect(200);
      const events = await outboxEvents(
        t.app,
        'developerplatform.api_version_pinned',
        { shopId: w.shop.id },
      );
      expect(events.map((e) => e.payload.version)).toEqual([LATEST, OLD]);
      expect(events[1].payload).toEqual({
        shopId: w.shop.id,
        version: OLD,
        previousVersion: LATEST,
        actorId: w.owner.id,
      });
    });

    it('S42 AS-30: an unknown version is 400, a retired one 422 version_retired, a member without shop.manage 403, another shop 404', async () => {
      const { w } = await world();
      const other = await t.seedWorld();
      await t
        .as(w.owner)
        .put(VERSION(w.shop.id))
        .send({ version: '1999-01-01' })
        .expect(400);
      await t
        .as(w.owner)
        .put(VERSION(w.shop.id))
        .send({ version: 'latest' })
        .expect(400);
      const staff = await addShopMember(t, w.shop.id, 'STAFF');
      await t
        .as(staff)
        .put(VERSION(w.shop.id))
        .send({ version: OLD })
        .expect(403);
      await t
        .as(other.owner)
        .put(VERSION(w.shop.id))
        .send({ version: OLD })
        .expect(404);

      const previous = registry[0].lifecycle;
      registry[0].lifecycle = { status: 'retired' };
      try {
        const res = await t
          .as(w.owner)
          .put(VERSION(w.shop.id))
          .send({ version: OLD })
          .expect(422);
        expect(res.body.code).toBe('version_retired');
      } finally {
        registry[0].lifecycle = previous;
      }
      expect(await pins(w.shop.id)).toEqual([{ pinnedVersion: LATEST }]);
    });

    it('S42 AS-30: concurrent pins leave one value and every instance agrees (20 repeats)', async () => {
      const { w, key } = await world();
      for (let i = 0; i < 20; i += 1) {
        const versions = i % 2 ? [OLD, LATEST] : [LATEST, OLD];
        await Promise.all(
          versions.map((version) =>
            t.as(w.owner).put(VERSION(w.shop.id)).send({ version }),
          ),
        );
        const [{ pinnedVersion }] = await pins(w.shop.id);
        expect(versions).toContain(pinnedVersion);
        const seen = await Promise.all([
          api(key).get('/v1/products'),
          api(key, pub2).get('/v1/products'),
        ]);
        expect(seen.map((r) => r.headers['marketplace-version'])).toEqual([
          pinnedVersion,
          pinnedVersion,
        ]);
      }
    });
  });

  describe('AS-32…AS-34 deprecation', () => {
    const stock = (key: CreatedKey, id: string) =>
      api(key).get(`/v1/products/${id}/stock`);
    const withProduct = async () => {
      const { w, key } = await world();
      const created = await create(key).expect(201);
      return { w, key, id: created.body.id as string };
    };

    it('S42 AS-32: the deprecated route announces itself with the three headers; its replacement has none', async () => {
      const { key, id } = await withProduct();
      const res = await stock(key, id).expect(200);
      expect(res.headers).toMatchObject(DEPRECATION_HEADERS);
      expect(res.headers.link).toBe(
        '<https://docs.marketplace.dev/api/deprecations>; rel="deprecation"; type="text/html", </v1/stock/{productId}>; rel="successor-version"',
      );
      expect(res.body).toMatchObject({ product_id: id, stock: 5 });
      const replacement = await api(key).get(`/v1/stock/${id}`).expect(200);
      for (const h of ['deprecation', 'sunset', 'link'])
        expect(replacement.headers[h]).toBeUndefined();
      expect(replacement.body).toMatchObject({
        object: 'stock',
        product_id: id,
        stock: 5,
      });
    });

    it('S42 AS-32: the headers are also on 404, 403 and 429 answers of the deprecated route', async () => {
      const { w, key } = await world();
      const readOnlyless = await createKey(t, w, { scopes: ['orders:read'] });
      const notFound = await stock(key, newId()).expect(404);
      expect(notFound.headers).toMatchObject(DEPRECATION_HEADERS);
      const forbidden = await stock(readOnlyless, newId()).expect(403);
      expect(forbidden.headers).toMatchObject(DEPRECATION_HEADERS);
      let last = notFound;
      for (let i = 0; i < 31; i += 1)
        last = await t.pub.http().get(`/v1/products/${newId()}/stock`);
      expect(last.status).toBe(429);
      expect(last.headers).toMatchObject(DEPRECATION_HEADERS);
    });

    it('S42 AS-33: a deprecated version announces itself, by header and by pin; the latest does not', async () => {
      const { w, key } = await world();
      const header = await api(key)
        .get('/v1/products')
        .set('Marketplace-Version', OLD)
        .expect(200);
      expect(header.headers).toMatchObject(DEPRECATION_HEADERS);
      expect(header.headers.link).toContain('rel="deprecation"');
      expect(header.headers.link).toMatch(
        /<[^>]*2026-10-01[^>]*>; rel="successor-version"/,
      );
      await t
        .as(w.owner)
        .put(VERSION(w.shop.id))
        .send({ version: OLD })
        .expect(200);
      const pinned = await api(key).get('/v1/products').expect(200);
      expect(pinned.headers).toMatchObject(DEPRECATION_HEADERS);
      const latest = await api(key)
        .get('/v1/products')
        .set('Marketplace-Version', LATEST)
        .expect(200);
      for (const h of ['deprecation', 'sunset', 'link'])
        expect(latest.headers[h]).toBeUndefined();
    });

    it('S42 AS-34: from the sunset the route answers 410 endpoint_retired with its successor; the replacement is unaffected', async () => {
      const { key, id } = await withProduct();
      t.clock.set(new Date('2027-04-01T00:00:00.000Z'));
      const gone = await stock(key, id).expect(410);
      expect(gone.body.code).toBe('endpoint_retired');
      expect(gone.body.successor).toBe('/v1/stock/{productId}');
      expect(gone.headers.link).toContain('rel="successor-version"');
      await api(key).get(`/v1/stock/${id}`).expect(200);
    });

    it('S42 AS-34: inside a brownout window the route answers 410 endpoint_brownout with Retry-After, and 200 again after it', async () => {
      const { key, id } = await withProduct();
      const previous = routeEntry.brownouts;
      routeEntry.brownouts = [
        { from: '2027-01-10T10:00:00.000Z', to: '2027-01-10T11:00:00.000Z' },
      ];
      try {
        t.clock.set(new Date('2027-01-10T10:30:00.000Z'));
        const res = await stock(key, id).expect(410);
        expect(res.body.code).toBe('endpoint_brownout');
        expect(res.headers['retry-after']).toBe('1800');
        t.clock.set(new Date('2027-01-10T11:00:00.000Z'));
        await stock(key, id).expect(200);
      } finally {
        routeEntry.brownouts = previous;
      }
    });

    it('S42 AS-34: a call at a retired version answers 410 version_retired and points to the supported versions', async () => {
      const { key } = await world();
      t.clock.set(new Date('2027-04-01T00:00:00.000Z'));
      const res = await api(key)
        .get('/v1/products')
        .set('Marketplace-Version', OLD)
        .expect(410);
      expect(res.body.code).toBe('version_retired');
      expect(res.body.supported).toEqual([LATEST]);
      await api(key)
        .get('/v1/products')
        .set('Marketplace-Version', LATEST)
        .expect(200);
    });

    it('S42 AS-33: calls at a deprecated version are counted per route and version, never per key', async () => {
      const { key } = await world();
      const read = () =>
        MetricsRegistry.value('public_api_deprecated_calls_total', {
          route: '/v1/products',
          version: OLD,
        }) ?? 0;
      const before = read();
      await api(key)
        .get('/v1/products')
        .set('Marketplace-Version', OLD)
        .expect(200);
      await api(key)
        .get('/v1/products')
        .set('Marketplace-Version', OLD)
        .expect(200);
      expect(read() - before).toBe(2);
      for (const labels of MetricsRegistry.labelSets(
        'public_api_deprecated_calls_total',
      ))
        expect(Object.keys(labels).sort()).toEqual(['route', 'version']);
    });
  });
});
