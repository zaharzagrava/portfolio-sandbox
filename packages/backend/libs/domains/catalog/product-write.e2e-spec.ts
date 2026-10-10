import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  productEventSchemas,
  productMemberSchema,
  productPageSchema,
  type ProductMemberView,
} from '@marketplace-sandbox/contracts';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import {
  createProduct,
  createProducts,
  productCount,
  productEvents,
  productRow,
} from '@app/test/utils/catalog-fixtures';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import {
  catalogEventCount,
  createShopWorld,
  productEntryExists,
  stableProblem,
  warmProductEntry,
  type ShopWorld,
} from './testing/catalog-spec-kit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const validBody = {
  title: 'Wool coat',
  description: 'Warm',
  brand: 'Nord',
  category: 'coats',
  priceMinor: 12_900,
  quantity: 5,
  tags: [' Winter ', 'winter', 'Wool'],
};

describe('Product write API', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;
  let w: ShopWorld;

  const rows = <T extends object>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements });

  const base = (shopId = w.shop.id) => `/api/shops/${shopId}/products`;

  beforeAll(async () => {
    t = await createCatalogApp();
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
  });

  describe('create (AS-01, AS-02, AS-03)', () => {
    it('S05 AS-01: a STAFF member creates a product: member view, one row, one created event, no cache entry', async () => {
      const res = await t.as(w.staff).post(base()).send(validBody).expect(201);

      const view = productMemberSchema.parse(res.body);
      expect(view).toMatchObject({
        shopId: w.shop.id,
        status: 'ACTIVE',
        version: 1,
        viewCount: 0,
        rating: 0,
        priceMinor: 12_900,
        currency: 'USD',
        quantity: 5,
        inStock: true,
        tags: ['winter', 'wool'],
        title: 'Wool coat',
        externalSku: null,
      });
      expect(view.id).toMatch(UUID);
      expect(view.createdAt).toBe(view.updatedAt);
      expect(JSON.stringify(res.body)).not.toMatch(
        /sellerId|embedding|searchVector|createdBy|isSandbox/,
      );

      expect(await productCount(t.app, `"shopId" = :s`, { s: w.shop.id })).toBe(
        1,
      );
      const stored = await productRow<{
        createdBy: string;
        isSandbox: boolean;
        version: number;
      }>(t.app, view.id);
      expect(stored).toMatchObject({
        createdBy: w.staff.id,
        isSandbox: false,
        version: 1,
      });

      const events = await productEvents(t.app, view.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        topic: 'products.events',
        aggregateType: 'products',
        type: 'catalog.product_created',
        version: 1,
        aggregateId: view.id,
        aggregateVersion: 1,
      });
      const payload = productEventSchemas['catalog.product_created'].parse(
        events[0].payload,
      );
      expect(payload).toMatchObject({
        productId: view.id,
        shopId: w.shop.id,
        title: 'Wool coat',
        tags: ['winter', 'wool'],
        quantity: 5,
        inStock: true,
        status: 'ACTIVE',
        isSandbox: false,
        productVersion: 1,
        changedFields: [],
      });
      expect(await productEntryExists(t.app, view.id)).toBe(false);
    });

    it('S05 AS-01: optional fields default (empty description and tags, quantity 0)', async () => {
      const res = await t
        .as(w.owner)
        .post(base())
        .send({ title: 'Plain', brand: 'B', category: 'c', priceMinor: 1 })
        .expect(201);
      expect(productMemberSchema.parse(res.body)).toMatchObject({
        description: '',
        tags: [],
        quantity: 0,
        inStock: false,
      });
    });

    it('S05 AS-03: the platform currency is accepted and the default; any other code is 422 and nothing is persisted', async () => {
      const ok = await t
        .as(w.staff)
        .post(base())
        .send({ ...validBody, currency: 'USD' })
        .expect(201);
      expect(ok.body.currency).toBe('USD');

      const before = await catalogEventCount(t.app);
      const res = await t
        .as(w.staff)
        .post(base())
        .send({ ...validBody, currency: 'EUR' })
        .expect(422);
      expect(res.body.code).toBe('currency_not_supported');
      expect(await productCount(t.app)).toBe(1);
      expect(await catalogEventCount(t.app)).toBe(before);
    });
  });

  describe('validation (AS-02, AS-08)', () => {
    const createCases: Array<[string, Record<string, unknown>, string]> = [
      ['title missing', { title: undefined }, 'title'],
      ['title empty', { title: '' }, 'title'],
      ['title whitespace', { title: '   ' }, 'title'],
      ['title 201 characters', { title: 'x'.repeat(201) }, 'title'],
      ['description 4001', { description: 'x'.repeat(4_001) }, 'description'],
      ['brand missing', { brand: undefined }, 'brand'],
      ['brand empty', { brand: '' }, 'brand'],
      ['brand 101', { brand: 'x'.repeat(101) }, 'brand'],
      ['category missing', { category: undefined }, 'category'],
      ['category 101', { category: 'x'.repeat(101) }, 'category'],
      ['priceMinor missing', { priceMinor: undefined }, 'priceMinor'],
      ['priceMinor fractional', { priceMinor: 12.5 }, 'priceMinor'],
      ['priceMinor string', { priceMinor: '100' }, 'priceMinor'],
      ['priceMinor zero', { priceMinor: 0 }, 'priceMinor'],
      ['priceMinor negative', { priceMinor: -5 }, 'priceMinor'],
      ['priceMinor above max', { priceMinor: 10_000_000_001 }, 'priceMinor'],
      ['quantity negative', { quantity: -1 }, 'quantity'],
      ['quantity fractional', { quantity: 1.5 }, 'quantity'],
      ['quantity above max', { quantity: 1_000_000_001 }, 'quantity'],
      [
        '33 tags',
        { tags: Array.from({ length: 33 }, (_, i) => `t${i}`) },
        'tags',
      ],
      ['empty tag', { tags: [''] }, 'tags'],
      ['51-character tag', { tags: ['x'.repeat(51)] }, 'tags'],
      ['non-string tag', { tags: [7] }, 'tags'],
      ['seller-supplied rating', { rating: 5 }, 'rating'],
      ['shopId', { shopId: '00000000-0000-4000-8000-000000000000' }, 'shopId'],
      ['id', { id: '00000000-0000-4000-8000-000000000000' }, 'id'],
      ['status', { status: 'ARCHIVED' }, 'status'],
      ['version', { version: 9 }, 'version'],
      ['viewCount', { viewCount: 9 }, 'viewCount'],
      ['sellerId', { sellerId: w0() }, 'sellerId'],
      ['createdBy', { createdBy: w0() }, 'createdBy'],
      ['isSandbox', { isSandbox: true }, 'isSandbox'],
      ['externalSku', { externalSku: 'x' }, 'externalSku'],
    ];

    it.each(createCases)(
      'S05 AS-02: create refuses %s with 400 validation_failed and persists nothing',
      async (_name, patch, field) => {
        const before = await catalogEventCount(t.app);
        const res = await t
          .as(w.staff)
          .post(base())
          .send({ ...validBody, ...patch })
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(
          (res.body.errors as Array<{ field: string }>).map((e) => e.field),
        ).toContain(field);
        expect(await productCount(t.app)).toBe(0);
        expect(await catalogEventCount(t.app)).toBe(before);
      },
    );

    it('S05 AS-02: a shop id that is not a UUID answers the hidden-shop 404 before validation (S03 answer order)', async () => {
      const res = await t
        .as(w.staff)
        .post('/api/shops/not-a-uuid/products')
        .send(validBody)
        .expect(404);
      expect(res.body.code).toBe('shop_not_found');
      expect(await productCount(t.app)).toBe(0);
    });

    const updateCases: Array<[string, Record<string, unknown>, string]> = [
      [
        'expectedVersion missing',
        { expectedVersion: undefined },
        'expectedVersion',
      ],
      ['expectedVersion zero', { expectedVersion: 0 }, 'expectedVersion'],
      [
        'expectedVersion fractional',
        { expectedVersion: 1.5 },
        'expectedVersion',
      ],
      ['expectedVersion string', { expectedVersion: '3' }, 'expectedVersion'],
      ['no field to change', { title: undefined }, '(body)'],
      ['title null', { title: null }, 'title'],
      ['title empty', { title: '' }, 'title'],
      ['title 201', { title: 'x'.repeat(201) }, 'title'],
      ['priceMinor zero', { priceMinor: 0 }, 'priceMinor'],
      ['quantity negative', { quantity: -1 }, 'quantity'],
      ['tags with empty tag', { tags: [''] }, 'tags'],
      ['id', { id: '00000000-0000-4000-8000-000000000000' }, 'id'],
      ['shopId', { shopId: '00000000-0000-4000-8000-000000000000' }, 'shopId'],
      ['status', { status: 'ARCHIVED' }, 'status'],
      ['rating', { rating: 1 }, 'rating'],
      ['viewCount', { viewCount: 1 }, 'viewCount'],
      ['version', { version: 1 }, 'version'],
      ['externalSku', { externalSku: 'x' }, 'externalSku'],
      ['isSandbox', { isSandbox: true }, 'isSandbox'],
      ['createdBy', { createdBy: w0() }, 'createdBy'],
    ];

    it.each(updateCases)(
      'S05 AS-08: update refuses %s with 400 validation_failed and changes nothing',
      async (_name, patch, field) => {
        const product = await createProduct(t.app, w.shop, { version: 3 });
        const before = await catalogEventCount(t.app);
        const res = await t
          .as(w.staff)
          .patch(`${base()}/${product.id}`)
          .send({ expectedVersion: 3, title: 'New title', ...patch })
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(
          (res.body.errors as Array<{ field: string }>).map((e) => e.field),
        ).toContain(field);
        const stored = await productRow<{ version: number; title: string }>(
          t.app,
          product.id,
        );
        expect(stored).toMatchObject({ version: 3, title: product.title });
        expect(await catalogEventCount(t.app)).toBe(before);
      },
    );

    it('S05 AS-08: a product id that is not a UUID is 400', async () => {
      for (const call of [
        t.as(w.staff).patch(`${base()}/not-a-uuid`).send({
          expectedVersion: 1,
          title: 'x',
        }),
        t.as(w.staff).post(`${base()}/not-a-uuid/archive`).send({
          expectedVersion: 1,
        }),
        t.as(w.staff).post(`${base()}/not-a-uuid/restore`).send({
          expectedVersion: 1,
        }),
        t.as(w.staff).get(`${base()}/not-a-uuid`),
      ]) {
        const res = await call.expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
    });

    it('S05 AS-08: archive and restore require a positive integer expectedVersion and refuse extra fields', async () => {
      const product = await createProduct(t.app, w.shop);
      for (const body of [
        {},
        { expectedVersion: 0 },
        { expectedVersion: '1' },
        { expectedVersion: 1, status: 'ARCHIVED' },
      ]) {
        const res = await t
          .as(w.staff)
          .post(`${base()}/${product.id}/archive`)
          .send(body)
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
      expect(
        (await productRow<{ status: string }>(t.app, product.id))!.status,
      ).toBe('ACTIVE');
    });
  });

  describe('who may write (AS-04, AS-05, AS-06)', () => {
    it('S05 AS-04: no credentials 401, VIEWER 403, non-member and unknown shop the same 404; nothing is persisted', async () => {
      const anonymous = await t.http().post(base()).send(validBody).expect(401);
      expect(anonymous.body.status).toBe(401);

      const viewer = await t
        .as(w.viewer)
        .post(base())
        .send(validBody)
        .expect(403);
      expect(viewer.body.code).toBe('permission_denied');

      const outsider = await t
        .as(w.outsider)
        .post(base())
        .send(validBody)
        .expect(404);
      const unknown = await t
        .as(w.outsider)
        .post(base('00000000-0000-4000-8000-0000000000aa'))
        .send(validBody)
        .expect(404);
      expect(stableProblem(outsider.body)).toEqual(stableProblem(unknown.body));
      expect(outsider.body.code).toBe('shop_not_found');

      expect(await productCount(t.app)).toBe(0);
      expect(await catalogEventCount(t.app)).toBe(0);
    });

    it.each([
      ['owner', 'owner'],
      ['admin', 'admin'],
      ['staff', 'staff'],
    ] as const)('S05 AS-04: a %s may write', async (_label, who) => {
      await t.as(w[who]).post(base()).send(validBody).expect(201);
    });

    it('S05 AS-05: a SUSPENDED shop refuses every write with 403 shop_suspended; a DELETING shop with 409 shop_offboarding', async () => {
      for (const [status, code, http] of [
        ['SUSPENDED', 'shop_suspended', 403],
        ['DELETING', 'shop_offboarding', 409],
      ] as const) {
        const closed = await createShopWorld(t, { status });
        const product = await createProduct(t.app, closed.shop);
        const calls = [
          t.as(closed.staff).post(base(closed.shop.id)).send(validBody),
          t
            .as(closed.staff)
            .patch(`${base(closed.shop.id)}/${product.id}`)
            .send({ expectedVersion: 1, title: 'x' }),
          t
            .as(closed.staff)
            .post(`${base(closed.shop.id)}/${product.id}/archive`)
            .send({ expectedVersion: 1 }),
          t
            .as(closed.staff)
            .post(`${base(closed.shop.id)}/${product.id}/restore`)
            .send({ expectedVersion: 1 }),
        ];
        for (const call of calls) {
          const res = await call.expect(http);
          expect(res.body.code).toBe(code);
        }
        const stored = await productRow<{ version: number; status: string }>(
          t.app,
          product.id,
        );
        expect(stored).toMatchObject({ version: 1, status: 'ACTIVE' });
      }
      expect(await catalogEventCount(t.app)).toBe(0);
    });

    it('S05 AS-06: the shop-less create routes are gone and create nothing', async () => {
      await t.as(w.staff).post('/api/products').send(validBody).expect(404);
      await t
        .as(w.staff)
        .post(`/api/products/shops/${w.shop.id}`)
        .send({ ...validBody, price: 100 })
        .expect(404);
      expect(await productCount(t.app)).toBe(0);
    });
  });

  describe('update (AS-07, AS-09, AS-10, AS-11)', () => {
    it('S05 AS-07: an update bumps the version, sets updatedAt from the clock, writes one updated event and deletes the cache entry before answering', async () => {
      const product = await createProduct(t.app, w.shop, {
        version: 3,
        priceMinor: 12_900,
        quantity: 5,
      });
      await warmProductEntry(t.app, product.id, 3);
      expect(await productEntryExists(t.app, product.id)).toBe(true);
      const T = new Date('2026-10-10T12:00:00.000Z');
      t.clock.set(T);
      await t.reauth(w.staff);

      const res = await t
        .as(w.staff)
        .patch(`${base()}/${product.id}`)
        .send({ expectedVersion: 3, priceMinor: 9_900, quantity: 12 })
        .expect(200);

      const view = productMemberSchema.parse(res.body);
      expect(view).toMatchObject({
        priceMinor: 9_900,
        quantity: 12,
        version: 4,
        updatedAt: T.toISOString(),
        title: product.title,
      });
      expect(await productEntryExists(t.app, product.id)).toBe(false);

      const events = await productEvents(t.app, product.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'catalog.product_updated',
        aggregateVersion: 4,
      });
      const payload = productEventSchemas['catalog.product_updated'].parse(
        events[0].payload,
      );
      expect(payload).toMatchObject({
        productVersion: 4,
        priceMinor: 9_900,
        quantity: 12,
        changedFields: ['priceMinor', 'quantity'],
      });
    });

    it('S05 AS-07: every editable field can change and is reported in changedFields', async () => {
      const product = await createProduct(t.app, w.shop, { version: 1 });
      const res = await t
        .as(w.admin)
        .patch(`${base()}/${product.id}`)
        .send({
          expectedVersion: 1,
          title: 'T2',
          description: 'D2',
          brand: 'B2',
          category: 'c2',
          tags: [' A ', 'a', 'B'],
        })
        .expect(200);
      expect(res.body).toMatchObject({
        title: 'T2',
        description: 'D2',
        brand: 'B2',
        category: 'c2',
        tags: ['a', 'b'],
        version: 2,
      });
      const [event] = await productEvents(t.app, product.id);
      expect(
        (event.payload as { changedFields: string[] }).changedFields,
      ).toEqual(['title', 'description', 'brand', 'category', 'tags']);
    });

    it('S05 AS-09: an update that changes nothing writes nothing: same view, no event, cache entry untouched; a stale version still conflicts', async () => {
      const product = await createProduct(t.app, w.shop, {
        version: 3,
        tags: ['winter', 'wool'],
      });
      const seeded = (await productRow<{ updatedAt: Date }>(
        t.app,
        product.id,
      ))!;
      await warmProductEntry(t.app, product.id, 3);
      t.clock.set(new Date('2026-12-24T10:00:00.000Z'));
      await t.reauth(w.staff);

      const res = await t
        .as(w.staff)
        .patch(`${base()}/${product.id}`)
        .send({
          expectedVersion: 3,
          title: product.title,
          tags: [' Winter ', 'WOOL', 'wool'],
        })
        .expect(200);
      expect(res.body).toMatchObject({ version: 3 });
      expect(new Date(res.body.updatedAt).getTime()).toBe(
        seeded.updatedAt.getTime(),
      );
      expect(await productEvents(t.app, product.id)).toHaveLength(0);
      expect(await productEntryExists(t.app, product.id)).toBe(true);

      const stale = await t
        .as(w.staff)
        .patch(`${base()}/${product.id}`)
        .send({ expectedVersion: 2, title: product.title })
        .expect(409);
      expect(stale.body.code).toBe('version_conflict');
    });

    it.each([
      ['PATCH', 'patch', (p: string) => `${p}`, { title: 'New' }],
      ['archive', 'post', (p: string) => `${p}/archive`, {}],
      ['restore', 'post', (p: string) => `${p}/restore`, {}],
    ] as const)(
      'S05 AS-10: %s with a stale expectedVersion is 409 version_conflict carrying currentVersion; nothing changes',
      async (_name, verb, path, extra) => {
        const product = await createProduct(t.app, w.shop, {
          version: 4,
          status: _name === 'restore' ? 'ARCHIVED' : 'ACTIVE',
        });
        const before = await catalogEventCount(t.app);
        const res = await t
          .as(w.staff)
          [verb](path(`${base()}/${product.id}`))
          .send({ expectedVersion: 3, ...extra })
          .expect(409);
        expect(res.body).toMatchObject({
          code: 'version_conflict',
          currentVersion: 4,
        });
        const stored = await productRow<{ version: number; title: string }>(
          t.app,
          product.id,
        );
        expect(stored).toMatchObject({ version: 4, title: product.title });
        expect(await catalogEventCount(t.app)).toBe(before);
      },
    );

    it('S05 AS-11: two concurrent updates with the same expectedVersion: exactly one 200, one 409, the winner stored, one event', async () => {
      const product = await createProduct(t.app, w.shop, { version: 3 });
      const [a, b] = await Promise.all([
        t
          .as(w.staff)
          .patch(`${base()}/${product.id}`)
          .send({ expectedVersion: 3, title: 'Title A' }),
        t
          .as(w.admin)
          .patch(`${base()}/${product.id}`)
          .send({ expectedVersion: 3, title: 'Title B' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const winner = a.status === 200 ? a : b;
      const loser = a.status === 200 ? b : a;
      expect(loser.body.code).toBe('version_conflict');
      expect(winner.body.version).toBe(4);
      const stored = await productRow<{ title: string; version: number }>(
        t.app,
        product.id,
      );
      expect(stored).toMatchObject({ title: winner.body.title, version: 4 });
      const events = await productEvents(t.app, product.id);
      expect(events.map((e) => e.type)).toEqual(['catalog.product_updated']);
    });
  });

  describe('cross-shop access and reads (AS-12, AS-13)', () => {
    it('S05 AS-12: a member of another shop gets the same 404 as for an unknown id, on either shop path, for every verb', async () => {
      const other = await createShopWorld(t);
      const product = await createProduct(t.app, w.shop);
      const unknownProduct = '00000000-0000-4000-8000-0000000000bb';
      const unknownShop = '00000000-0000-4000-8000-0000000000cc';
      const body = { expectedVersion: 1, title: 'Hijack' };

      const verbs = [
        ['GET', (p: string) => t.as(other.staff).get(p)],
        ['PATCH', (p: string) => t.as(other.staff).patch(p).send(body)],
        [
          'archive',
          (p: string) =>
            t.as(other.staff).post(`${p}/archive`).send({ expectedVersion: 1 }),
        ],
        [
          'restore',
          (p: string) =>
            t.as(other.staff).post(`${p}/restore`).send({ expectedVersion: 1 }),
        ],
      ] as const;

      for (const [, call] of verbs) {
        // own shop path, foreign product: the product answer
        const foreign = await call(`${base(other.shop.id)}/${product.id}`);
        const missing = await call(`${base(other.shop.id)}/${unknownProduct}`);
        expect(foreign.status).toBe(404);
        expect(foreign.body.code).toBe('product_not_found');
        expect(stableProblem(foreign.body)).toEqual(
          stableProblem(missing.body),
        );

        // the owning shop's path: the hidden-shop answer, same as for a shop that does not exist
        const hidden = await call(`${base(w.shop.id)}/${product.id}`);
        const noShop = await call(`${base(unknownShop)}/${product.id}`);
        expect(hidden.status).toBe(404);
        expect(hidden.body.code).toBe('shop_not_found');
        expect(stableProblem(hidden.body)).toEqual(stableProblem(noShop.body));
      }

      const stored = await productRow<{ version: number; title: string }>(
        t.app,
        product.id,
      );
      expect(stored).toMatchObject({ version: 1, title: product.title });
      expect(await catalogEventCount(t.app)).toBe(0);

      const list = await t.as(other.owner).get(base(other.shop.id)).expect(200);
      expect(
        productPageSchema.parse(list.body).items.map((i) => i.id),
      ).not.toContain(product.id);
    });

    it.each(['owner', 'admin', 'staff', 'viewer'] as const)(
      'S05 AS-13: a %s reads one product, archived included, with the member view',
      async (who) => {
        const active = await createProduct(t.app, w.shop, { quantity: 7 });
        const archived = await createProduct(t.app, w.shop, {
          status: 'ARCHIVED',
          externalSku: 'EXT-9',
        });
        const a = await t.as(w[who]).get(`${base()}/${active.id}`).expect(200);
        expect(productMemberSchema.parse(a.body)).toMatchObject({
          id: active.id,
          quantity: 7,
          status: 'ACTIVE',
          externalSku: null,
        });
        const b = await t
          .as(w[who])
          .get(`${base()}/${archived.id}`)
          .expect(200);
        expect(productMemberSchema.parse(b.body)).toMatchObject({
          status: 'ARCHIVED',
          externalSku: 'EXT-9',
        });
      },
    );

    it('S05 AS-13: an unknown product is 404 product_not_found and a non-UUID id is 400', async () => {
      const res = await t
        .as(w.viewer)
        .get(`${base()}/00000000-0000-4000-8000-0000000000dd`)
        .expect(404);
      expect(res.body.code).toBe('product_not_found');
      await t.as(w.viewer).get(`${base()}/nope`).expect(400);
    });
  });

  describe('list (AS-14, AS-15)', () => {
    const page = async (query = '') => {
      const res = await t.as(w.viewer).get(`${base()}${query}`).expect(200);
      return productPageSchema.parse(res.body);
    };

    it('S05 AS-14: 45 products page 20/20/5 in createdAt-desc, id-desc order without duplicates or omissions, even when one is created between pages', async () => {
      const sameTime = new Date('2026-05-05T10:00:00.000Z');
      await createProducts(t.app, w.shop, 40);
      await createProducts(t.app, w.shop, 5, { createdAt: sameTime });
      const otherWorld = await createShopWorld(t);
      await createProducts(t.app, otherWorld.shop, 7);

      const first = await page('?limit=20');
      expect(first.items).toHaveLength(20);
      expect(first.nextCursor).not.toBeNull();
      // a new product appears between the page requests: it sorts before the cursor and must not shift the rest
      await createProduct(t.app, w.shop, { createdAt: new Date() });
      const second = await page(`?limit=20&cursor=${first.nextCursor}`);
      expect(second.items).toHaveLength(20);
      const third = await page(`?limit=20&cursor=${second.nextCursor}`);
      expect(third.items).toHaveLength(5);
      expect(third.nextCursor).toBeNull();

      const ids = [...first.items, ...second.items, ...third.items].map(
        (i) => i.id,
      );
      expect(new Set(ids).size).toBe(45);
      expect(first.items.every((i) => i.shopId === w.shop.id)).toBe(true);
      const keys = [...first.items, ...second.items, ...third.items].map(
        (i) => `${i.createdAt}|${i.id}`,
      );
      expect([...keys].sort().reverse()).toEqual(keys);
    });

    it('S05 AS-14: the default limit is 20', async () => {
      await createProducts(t.app, w.shop, 25);
      const first = await page();
      expect(first.items).toHaveLength(20);
    });

    it.each([
      ['limit=0'],
      ['limit=101'],
      ['limit=abc'],
      ['limit=1.5'],
      ['offset=5'],
      ['page=2'],
      ['cursor=!!!'],
      ['cursor=eyJ4Ijoie30ifQ'],
    ])('S05 AS-14: %s is 400', async (query) => {
      const res = await t.as(w.viewer).get(`${base()}?${query}`).expect(400);
      expect(['validation_failed', 'invalid_cursor']).toContain(res.body.code);
    });

    it('S05 AS-14: a cursor issued for another shop or another filter set is 400 invalid_cursor', async () => {
      await createProducts(t.app, w.shop, 5);
      const other = await createShopWorld(t);
      await createProducts(t.app, other.shop, 5);
      const mine = await page('?limit=2');
      const foreignShop = await t
        .as(other.viewer)
        .get(`${base(other.shop.id)}?limit=2&cursor=${mine.nextCursor}`)
        .expect(400);
      expect(foreignShop.body.code).toBe('invalid_cursor');
      const otherFilter = await t
        .as(w.viewer)
        .get(`${base()}?limit=2&category=electronics&cursor=${mine.nextCursor}`)
        .expect(400);
      expect(otherFilter.body.code).toBe('invalid_cursor');
    });

    it('S05 AS-15: filters by status, category and stock apply before paging; the default status is ACTIVE', async () => {
      await createProducts(t.app, w.shop, 3, {
        category: 'coats',
        quantity: 4,
      });
      await createProducts(t.app, w.shop, 2, {
        category: 'coats',
        quantity: 0,
      });
      await createProducts(t.app, w.shop, 2, { category: 'hats', quantity: 1 });
      await createProducts(t.app, w.shop, 2, {
        category: 'coats',
        status: 'ARCHIVED',
        quantity: 1,
      });

      expect((await page()).items).toHaveLength(7);
      expect((await page('?status=ARCHIVED')).items).toHaveLength(2);
      expect((await page('?category=coats')).items).toHaveLength(5);
      expect((await page('?inStock=false')).items).toHaveLength(2);
      expect((await page('?inStock=true')).items).toHaveLength(5);
      expect((await page('?category=coats&inStock=true')).items).toHaveLength(
        3,
      );
      expect((await page('?status=ARCHIVED&category=hats')).items).toHaveLength(
        0,
      );

      const filtered = await page('?category=coats&limit=2');
      expect(filtered.items).toHaveLength(2);
      const rest = await page(
        `?category=coats&limit=2&cursor=${filtered.nextCursor}`,
      );
      const last = await page(
        `?category=coats&limit=2&cursor=${rest.nextCursor}`,
      );
      expect(rest.items).toHaveLength(2);
      expect(last.items).toHaveLength(1);
      expect(last.nextCursor).toBeNull();
    });

    it.each([
      ['status=DELETED'],
      ['status=active'],
      ['inStock=maybe'],
      ['colour=red'],
    ])('S05 AS-15: %s is 400', async (query) => {
      await t.as(w.viewer).get(`${base()}?${query}`).expect(400);
    });
  });

  describe('archive and restore (AS-16 to AS-20)', () => {
    it('S05 AS-16: archive sets ARCHIVED, bumps the version, writes a history row and one archived event, and deletes the cache entry', async () => {
      const product = await createProduct(t.app, w.shop, { version: 4 });
      await warmProductEntry(t.app, product.id, 4);
      const T = new Date('2026-10-11T08:30:00.000Z');
      t.clock.set(T);
      await t.reauth(w.staff);

      const res = await t
        .as(w.staff)
        .post(`${base()}/${product.id}/archive`)
        .send({ expectedVersion: 4 })
        .expect(200);
      expect(productMemberSchema.parse(res.body)).toMatchObject({
        status: 'ARCHIVED',
        version: 5,
      });
      expect(await productEntryExists(t.app, product.id)).toBe(false);

      const history = await rows<{
        fromStatus: string;
        toStatus: string;
        actorId: string;
        at: Date;
        productVersion: number;
        shopId: string;
      }>(`SELECT * FROM "ProductStatusHistory" WHERE "productId" = :id`, {
        id: product.id,
      });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStatus: 'ACTIVE',
        toStatus: 'ARCHIVED',
        actorId: w.staff.id,
        productVersion: 5,
        shopId: w.shop.id,
      });
      expect(history[0].at.toISOString()).toBe(T.toISOString());

      const events = await productEvents(t.app, product.id);
      expect(events.map((e) => e.type)).toEqual(['catalog.product_archived']);
      const payload = productEventSchemas['catalog.product_archived'].parse(
        events[0].payload,
      );
      expect(payload).toMatchObject({ status: 'ARCHIVED', productVersion: 5 });
    });

    it('S05 AS-17: restore sets ACTIVE, bumps the version, writes a history row and one restored event', async () => {
      const product = await createProduct(t.app, w.shop, {
        version: 5,
        status: 'ARCHIVED',
      });
      const res = await t
        .as(w.admin)
        .post(`${base()}/${product.id}/restore`)
        .send({ expectedVersion: 5 })
        .expect(200);
      expect(productMemberSchema.parse(res.body)).toMatchObject({
        status: 'ACTIVE',
        version: 6,
      });
      const history = await rows<{ fromStatus: string; toStatus: string }>(
        `SELECT "fromStatus","toStatus" FROM "ProductStatusHistory" WHERE "productId" = :id`,
        { id: product.id },
      );
      expect(history).toEqual([{ fromStatus: 'ARCHIVED', toStatus: 'ACTIVE' }]);
      const events = await productEvents(t.app, product.id);
      expect(events.map((e) => e.type)).toEqual(['catalog.product_restored']);
      expect(
        productEventSchemas['catalog.product_restored'].parse(
          events[0].payload,
        ),
      ).toMatchObject({ status: 'ACTIVE', productVersion: 6 });
    });

    it('S05 AS-18: archiving an archived product and restoring an active one is 409 invalid_transition; no history, no event, no version change', async () => {
      const archived = await createProduct(t.app, w.shop, {
        status: 'ARCHIVED',
        version: 2,
      });
      const active = await createProduct(t.app, w.shop, { version: 2 });
      const a = await t
        .as(w.staff)
        .post(`${base()}/${archived.id}/archive`)
        .send({ expectedVersion: 2 })
        .expect(409);
      const b = await t
        .as(w.staff)
        .post(`${base()}/${active.id}/restore`)
        .send({ expectedVersion: 2 })
        .expect(409);
      expect(a.body.code).toBe('invalid_transition');
      expect(b.body.code).toBe('invalid_transition');
      expect(await catalogEventCount(t.app)).toBe(0);
      const [{ n }] = await rows<{ n: string }>(
        `SELECT count(*) AS n FROM "ProductStatusHistory"`,
      );
      expect(Number(n)).toBe(0);
      expect(
        (await productRow<{ version: number }>(t.app, archived.id))!.version,
      ).toBe(2);
    });

    it('S05 AS-19: an archived product refuses edits with 409 product_archived; after restore the same edit succeeds', async () => {
      const product = await createProduct(t.app, w.shop, {
        status: 'ARCHIVED',
        version: 3,
      });
      const refused = await t
        .as(w.staff)
        .patch(`${base()}/${product.id}`)
        .send({ expectedVersion: 3, title: 'Edited' })
        .expect(409);
      expect(refused.body.code).toBe('product_archived');
      expect(
        (await productRow<{ title: string }>(t.app, product.id))!.title,
      ).toBe(product.title);

      const restored = await t
        .as(w.staff)
        .post(`${base()}/${product.id}/restore`)
        .send({ expectedVersion: 3 })
        .expect(200);
      await t
        .as(w.staff)
        .patch(`${base()}/${product.id}`)
        .send({ expectedVersion: restored.body.version, title: 'Edited' })
        .expect(200);
    });

    it('S05 AS-20: archive racing an edit on the same version: one winner, one 409, a consistent final row and exactly one event', async () => {
      const product = await createProduct(t.app, w.shop, { version: 4 });
      const [archive, edit] = await Promise.all([
        t
          .as(w.staff)
          .post(`${base()}/${product.id}/archive`)
          .send({ expectedVersion: 4 }),
        t
          .as(w.admin)
          .patch(`${base()}/${product.id}`)
          .send({ expectedVersion: 4, title: 'Edited' }),
      ]);
      expect([archive.status, edit.status].sort()).toEqual([200, 409]);
      const loser = archive.status === 200 ? edit : archive;
      expect(['version_conflict', 'product_archived']).toContain(
        loser.body.code,
      );
      const stored = (await productRow<{
        status: string;
        title: string;
        version: number;
      }>(t.app, product.id))!;
      expect(stored.version).toBe(5);
      if (archive.status === 200) {
        expect(stored).toMatchObject({
          status: 'ARCHIVED',
          title: product.title,
        });
      } else {
        expect(stored).toMatchObject({ status: 'ACTIVE', title: 'Edited' });
      }
      const events = await productEvents(t.app, product.id);
      expect(events).toHaveLength(1);
      const [{ n }] = await rows<{ n: string }>(
        `SELECT count(*) AS n FROM "ProductStatusHistory" WHERE "productId" = :id`,
        { id: product.id },
      );
      expect(Number(n)).toBe(archive.status === 200 ? 1 : 0);
    });
  });

  describe('write rate limit (AS-22) and the role/state matrix (SC-001)', () => {
    it('S05 AS-22: the 121st write of a shop within the minute is 429 with Retry-After; reads of the shop still succeed and other shops are unaffected', async () => {
      const results: number[] = [];
      for (let i = 0; i < 120; i++) {
        const res = await t
          .as(w.staff)
          .post(base())
          .send({ ...validBody, title: `Coat ${i}` });
        results.push(res.status);
      }
      expect(results.every((s) => s === 201)).toBe(true);

      const limited = await t
        .as(w.staff)
        .post(base())
        .send(validBody)
        .expect(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(await productCount(t.app)).toBe(120);

      await t.as(w.viewer).get(base()).expect(200);
      const other = await createShopWorld(t);
      await t
        .as(other.staff)
        .post(base(other.shop.id))
        .send(validBody)
        .expect(201);
    });

    // SC-001: no combination of role or shop state outside "member with products.write on an active shop" changes data.
    const ROUTES = [
      {
        name: 'create',
        call: (
          t_: CatalogTestApp,
          as: ReturnType<CatalogTestApp['as']> | null,
          shopId: string,
          productId: string,
        ) => {
          void productId;
          const req = as
            ? as.post(base0(shopId))
            : t_.http().post(base0(shopId));
          return req.send(validBody);
        },
      },
      {
        name: 'update',
        call: (
          t_: CatalogTestApp,
          as: ReturnType<CatalogTestApp['as']> | null,
          shopId: string,
          productId: string,
        ) => {
          const url = `${base0(shopId)}/${productId}`;
          const req = as ? as.patch(url) : t_.http().patch(url);
          return req.send({ expectedVersion: 1, title: 'Matrix' });
        },
      },
      {
        name: 'archive',
        call: (
          t_: CatalogTestApp,
          as: ReturnType<CatalogTestApp['as']> | null,
          shopId: string,
          productId: string,
        ) => {
          const url = `${base0(shopId)}/${productId}/archive`;
          const req = as ? as.post(url) : t_.http().post(url);
          return req.send({ expectedVersion: 1 });
        },
      },
      {
        name: 'restore',
        call: (
          t_: CatalogTestApp,
          as: ReturnType<CatalogTestApp['as']> | null,
          shopId: string,
          productId: string,
        ) => {
          const url = `${base0(shopId)}/${productId}/restore`;
          const req = as ? as.post(url) : t_.http().post(url);
          return req.send({ expectedVersion: 1 });
        },
      },
    ] as const;

    const CLASSES: Array<{
      name: string;
      status: number;
      code?: string;
      pick: (world: ShopWorld) => 'anonymous' | keyof ShopWorld;
      shop?: 'unknown' | { status: 'SUSPENDED' | 'DELETING' };
    }> = [
      { name: 'anonymous', status: 401, pick: () => 'anonymous' },
      {
        name: 'viewer',
        status: 403,
        code: 'permission_denied',
        pick: () => 'viewer',
      },
      {
        name: 'outsider',
        status: 404,
        code: 'shop_not_found',
        pick: () => 'outsider',
      },
      {
        name: 'unknown shop',
        status: 404,
        code: 'shop_not_found',
        pick: () => 'staff',
        shop: 'unknown',
      },
      {
        name: 'staff of a suspended shop',
        status: 403,
        code: 'shop_suspended',
        pick: () => 'staff',
        shop: { status: 'SUSPENDED' },
      },
      {
        name: 'staff of a deleting shop',
        status: 409,
        code: 'shop_offboarding',
        pick: () => 'staff',
        shop: { status: 'DELETING' },
      },
    ];

    const cases = ROUTES.flatMap((route) =>
      CLASSES.map((klass) => [route.name, klass.name, route, klass] as const),
    );

    it.each(cases)(
      'S05 SC-001: %s as %s is refused with the expected status and changes nothing',
      async (_route, _klass, route, klass) => {
        const world =
          typeof klass.shop === 'object'
            ? await createShopWorld(t, klass.shop)
            : w;
        const product = await createProduct(t.app, world.shop, {
          status: route.name === 'restore' ? 'ARCHIVED' : 'ACTIVE',
        });
        const who = klass.pick(world);
        const as =
          who === 'anonymous' ? null : t.as(world[who] as ShopWorld['staff']);
        const shopId =
          klass.shop === 'unknown'
            ? '00000000-0000-4000-8000-0000000000ee'
            : world.shop.id;
        const res = await route.call(t, as, shopId, product.id);
        expect(res.status).toBe(klass.status);
        if (klass.code) expect(res.body.code).toBe(klass.code);

        const stored = (await productRow<{
          version: number;
          status: string;
          title: string;
        }>(t.app, product.id))!;
        expect(stored.version).toBe(1);
        expect(stored.title).toBe(product.title);
        expect(stored.status).toBe(
          route.name === 'restore' ? 'ARCHIVED' : 'ACTIVE',
        );
        expect(await catalogEventCount(t.app)).toBe(0);
        expect(
          await productCount(t.app, `"shopId" = :s`, { s: world.shop.id }),
        ).toBe(1);
      },
    );

    it('S05 SC-001: the permitted combination (member with products.write on an active shop) succeeds on every write route', async () => {
      const product = await createProduct(t.app, w.shop);
      await t.as(w.staff).post(base()).send(validBody).expect(201);
      const upd = await t
        .as(w.staff)
        .patch(`${base()}/${product.id}`)
        .send({ expectedVersion: 1, title: 'Matrix' })
        .expect(200);
      const arch = await t
        .as(w.staff)
        .post(`${base()}/${product.id}/archive`)
        .send({ expectedVersion: upd.body.version })
        .expect(200);
      await t
        .as(w.staff)
        .post(`${base()}/${product.id}/restore`)
        .send({ expectedVersion: arch.body.version })
        .expect(200);
    });
  });

  it('S05 AS-04: a member added later can write at once, in their own shop too (roles are read per request)', async () => {
    const late = await t.newUser();
    await addMember(t.app, w.shop.id, late.id, 'STAFF');
    await t.as(late).post(base()).send(validBody).expect(201);
    const other = await createShop(t.app, late);
    await t.as(late).post(base(other.id)).send(validBody).expect(201);
  });
});

describe('Product write API with the limiter store down', () => {
  let proxy: TcpFaultProxy;
  let t: CatalogTestApp;

  beforeAll(async () => {
    const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    proxy = await TcpFaultProxy.start({
      host: url.hostname,
      port: Number(url.port || 6379),
    });
    t = await createCatalogApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/0`,
    });
  });
  afterAll(async () => {
    proxy.mode = 'pass';
    await t.close();
    await proxy.close();
  });

  it('S05 AS-22: when the limiter store is unreachable writes are refused with 503 (fail closed) and reads are unaffected', async () => {
    await t.reset();
    const world = await createShopWorld(t);
    const url = `/api/shops/${world.shop.id}/products`;
    const product = await createProduct(t.app, world.shop);
    await t.as(world.staff).post(url).send(validBody).expect(201);

    proxy.mode = 'refuse';
    proxy.sever();
    await waitFor(
      async () => {
        const res = await t.as(world.staff).post(url).send(validBody);
        return res.status === 503;
      },
      { timeoutMs: 10_000, intervalMs: 100, description: 'fail closed' },
    );

    const refused = await t.as(world.staff).post(url).send(validBody);
    expect(refused.status).toBe(503);
    await t.as(world.viewer).get(url).expect(200);
    await t.as(world.viewer).get(`${url}/${product.id}`).expect(200);
    expect(
      await productCount(t.app, `"shopId" = :s`, { s: world.shop.id }),
    ).toBe(2);
    proxy.mode = 'pass';
  });
});

function w0(): string {
  return '00000000-0000-4000-8000-000000000000';
}
function base0(shopId: string): string {
  return `/api/shops/${shopId}/products`;
}

export type { ProductMemberView };
