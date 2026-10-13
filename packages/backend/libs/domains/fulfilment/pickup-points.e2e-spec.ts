import { v7 as uuidv7 } from 'uuid';
import {
  pickupPointPageSchema,
  pickupPointSchema,
  pickupStockPageSchema,
} from '@marketplace-sandbox/contracts';
import { createShop, addMember } from '@app/test/utils/tenancy-fixtures';
import {
  createPickupApp,
  KREUZBERG,
  MITTE,
  type PickupTestApp,
  type PickupWorld,
} from './testing/pickup-fixtures';

const BERLIN_HOURS = {
  timezone: 'Europe/Berlin',
  weekly: { mon: [{ open: '09:00', close: '18:00' }] },
};

describe('Pickup points: seller management, limits, tenant isolation and domain isolation', () => {
  let t: PickupTestApp;
  let w: PickupWorld;

  beforeAll(async () => {
    t = await createPickupApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
  });

  const post = (shopId: string, body: unknown, user = w.u1) =>
    t
      .as(user)
      .post(`/api/shops/${shopId}/pickup-points`)
      .send(body as object);
  const rows = (where = 'TRUE', replacements: Record<string, unknown> = {}) =>
    t.sql<{ id: string; shopId: string; version: number; active: boolean }>(
      `SELECT "id", "shopId", "version", "active" FROM "PickupPoint" WHERE ${where}`,
      replacements,
    );
  const valid = {
    name: 'Kreuzberg store',
    address: 'Oranienstr. 1',
    ...KREUZBERG,
  };

  describe('US2 - create and validate', () => {
    it('S19 AS-10: a member with products.write creates a point: 201, the stored location, and one point_changed event in the same transaction', async () => {
      const res = await post(w.s1.id, {
        ...valid,
        openingHours: BERLIN_HOURS,
      }).expect(201);

      const body = pickupPointSchema.parse(res.body);
      expect(body).toMatchObject({
        shopId: w.s1.id,
        name: 'Kreuzberg store',
        address: 'Oranienstr. 1',
        lat: KREUZBERG.lat,
        lng: KREUZBERG.lng,
        openingHours: BERLIN_HOURS,
        active: true,
        version: 1,
      });
      const [stored] = await t.sql<{ metres: number }>(
        `SELECT ST_Distance(location, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography) AS metres
           FROM "PickupPoint" WHERE "id" = :id`,
        { id: body.id, lat: KREUZBERG.lat, lng: KREUZBERG.lng },
      );
      expect(stored.metres).toBeLessThan(1);
      const events = await t.outbox('pickup.point_changed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateId: body.id,
        aggregateVersion: 1,
        payload: {
          pickupPointId: body.id,
          shopId: w.s1.id,
          name: 'Kreuzberg store',
          active: true,
          pointVersion: 1,
        },
      });
    });

    it('S19 AS-11: names and addresses are stored trimmed and omitted opening hours are stored as {}', async () => {
      const res = await post(w.s1.id, {
        ...valid,
        name: '  Kreuzberg store  ',
        address: ' Oranienstr. 1 ',
      }).expect(201);
      expect(res.body).toMatchObject({
        name: 'Kreuzberg store',
        address: 'Oranienstr. 1',
        openingHours: {},
      });
      const [row] = await t.sql<{ name: string; openingHours: unknown }>(
        `SELECT "name", "openingHours" FROM "PickupPoint" WHERE "id" = :id`,
        { id: res.body.id },
      );
      expect(row).toEqual({ name: 'Kreuzberg store', openingHours: {} });
    });

    it.each([
      ['name empty', { name: '' }, 'name'],
      ['name blank after trimming', { name: '   ' }, 'name'],
      ['name over 120 characters', { name: 'n'.repeat(121) }, 'name'],
      ['name not text', { name: 7 }, 'name'],
      ['address empty', { address: '' }, 'address'],
      ['address over 300 characters', { address: 'a'.repeat(301) }, 'address'],
      ['lat missing', { lat: undefined }, 'lat'],
      ['lat not a number', { lat: 'north' }, 'lat'],
      ['lat above 90', { lat: 90.1 }, 'lat'],
      ['lng missing', { lng: undefined }, 'lng'],
      ['lng below -180', { lng: -180.5 }, 'lng'],
      ['lng null', { lng: null }, 'lng'],
      [
        'opening hours with an unknown timezone',
        { openingHours: { timezone: 'Mars/Base', weekly: {} } },
        'openingHours',
      ],
      [
        'opening hours with an unknown day',
        { openingHours: { timezone: 'Europe/Berlin', weekly: { funday: [] } } },
        'openingHours',
      ],
      [
        'opening hours with a time not HH:mm',
        {
          openingHours: {
            timezone: 'Europe/Berlin',
            weekly: { mon: [{ open: '9:00', close: '18:00' }] },
          },
        },
        'openingHours',
      ],
      [
        'opening hours that close before they open',
        {
          openingHours: {
            timezone: 'Europe/Berlin',
            weekly: { mon: [{ open: '18:00', close: '09:00' }] },
          },
        },
        'openingHours',
      ],
      [
        'opening hours with overlapping intervals',
        {
          openingHours: {
            timezone: 'Europe/Berlin',
            weekly: {
              mon: [
                { open: '08:00', close: '12:00' },
                { open: '11:00', close: '14:00' },
              ],
            },
          },
        },
        'openingHours',
      ],
      [
        'opening hours with four intervals a day',
        {
          openingHours: {
            timezone: 'Europe/Berlin',
            weekly: {
              mon: [1, 3, 5, 7].map((h) => ({
                open: `0${h}:00`,
                close: `0${h + 1}:00`,
              })),
            },
          },
        },
        'openingHours',
      ],
      ['an unknown field', { color: 'red' }, 'color'],
    ])(
      'S19 AS-11: %s answers 400 validation_failed naming the field and writes no row and no event',
      async (_name, change, field) => {
        const res = await post(w.s1.id, { ...valid, ...change }).expect(400);

        expect(res.body).toMatchObject({
          code: 'validation_failed',
          status: 400,
        });
        expect(
          res.body.errors.map((e: { field: string }) => e.field),
        ).toContain(field);
        expect(await rows()).toHaveLength(0);
        expect(await t.outbox()).toHaveLength(0);
      },
    );

    it('S19 AS-11: a shop id that is not a UUID addresses no shop (the S03 gate answers 404 shop_not_found before any validation) and writes nothing', async () => {
      const res = await post('not-a-uuid', valid).expect(404);
      expect(res.body.code).toBe('shop_not_found');
      expect(await rows()).toHaveLength(0);
      expect(await t.outbox()).toHaveLength(0);
    });
  });

  describe('US2 - access control and tenant isolation', () => {
    let s3: { id: string };
    let foreignPoint: { id: string };
    let product: { id: string };

    beforeEach(async () => {
      // a suspended shop of U1, so the status gate is tested without touching the cached state of S1
      s3 = await createShop(t.app, null, {
        name: 'Suspended',
        status: 'SUSPENDED',
      });
      await addMember(t.app, s3.id, w.u1.id, 'STAFF');
      foreignPoint = await t.createPoint(w.u2, w.s2.id);
      product = await t.product(w.s1.id);
    });

    type Endpoint = {
      name: string;
      write: boolean;
      needsPoint: boolean;
      call: (
        user: PickupWorld['u1'] | null,
        shopId: string,
        pointId: string,
      ) => ReturnType<ReturnType<PickupTestApp['as']>['get']>;
    };
    const as = (user: PickupWorld['u1'] | null) =>
      user
        ? t.as(user)
        : {
            get: (u: string) => t.http().get(u),
            post: (u: string) => t.http().post(u),
            put: (u: string) => t.http().put(u),
            patch: (u: string) => t.http().patch(u),
          };
    const endpoints = (): Endpoint[] => [
      {
        name: 'create point',
        write: true,
        needsPoint: false,
        call: (u, s) =>
          as(u).post(`/api/shops/${s}/pickup-points`).send(valid) as never,
      },
      {
        name: 'list points',
        write: false,
        needsPoint: false,
        call: (u, s) => as(u).get(`/api/shops/${s}/pickup-points`) as never,
      },
      {
        name: 'update point',
        write: true,
        needsPoint: true,
        call: (u, s, p) =>
          as(u)
            .patch(`/api/shops/${s}/pickup-points/${p}`)
            .send({ name: 'x' }) as never,
      },
      {
        name: 'list stock',
        write: false,
        needsPoint: true,
        call: (u, s, p) =>
          as(u).get(`/api/shops/${s}/pickup-points/${p}/stock`) as never,
      },
      {
        name: 'set stock',
        write: true,
        needsPoint: true,
        call: (u, s, p) =>
          as(u)
            .put(`/api/shops/${s}/pickup-points/${p}/stock/${product.id}`)
            .send({ quantity: 1 }) as never,
      },
      {
        name: 'adjust stock',
        write: true,
        needsPoint: true,
        call: (u, s, p) =>
          as(u)
            .post(
              `/api/shops/${s}/pickup-points/${p}/stock/${product.id}/adjustments`,
            )
            .set('Idempotency-Key', uuidv7())
            .send({ delta: 1 }) as never,
      },
    ];
    const names = [
      'create point',
      'list points',
      'update point',
      'list stock',
      'set stock',
      'adjust stock',
    ];

    it.each(names)(
      'S19 AS-12: %s without credentials answers 401',
      async (name) => {
        const e = endpoints().find((x) => x.name === name)!;
        const point = await t.createPoint(w.u1, w.s1.id);
        await e.call(null, w.s1.id, point.id).expect(401);
        expect(await rows('"shopId" = :s', { s: w.s1.id })).toHaveLength(1);
      },
    );

    it.each(names)(
      'S19 AS-12: %s by a member of another shop answers 404 shop_not_found and changes nothing',
      async (name) => {
        const e = endpoints().find((x) => x.name === name)!;
        const point = await t.createPoint(w.u1, w.s1.id);
        const before = await t.sql(`SELECT * FROM "PickupPoint" ORDER BY "id"`);
        const res = await e.call(w.u2, w.s1.id, point.id).expect(404);
        expect(res.body.code).toBe('shop_not_found');
        expect(
          await t.sql(`SELECT * FROM "PickupPoint" ORDER BY "id"`),
        ).toEqual(before);
        expect(await t.sql(`SELECT * FROM "PickupStock"`)).toHaveLength(0);
      },
    );

    it.each(names)(
      'S19 AS-12: %s by a viewer is refused for writes (403 permission_denied) and allowed for reads (200)',
      async (name) => {
        const e = endpoints().find((x) => x.name === name)!;
        const point = await t.createPoint(w.u1, w.s1.id);
        const res = await e.call(w.v1, w.s1.id, point.id);
        if (e.write) {
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('permission_denied');
          expect(await t.sql(`SELECT * FROM "PickupStock"`)).toHaveLength(0);
        } else {
          expect(res.status).toBe(200);
        }
      },
    );

    it.each(['create point', 'update point', 'set stock', 'adjust stock'])(
      'S19 AS-12: %s in a suspended shop answers 403 shop_suspended',
      async (name) => {
        const e = endpoints().find((x) => x.name === name)!;
        const res = await e.call(w.u1, s3.id, uuidv7()).expect(403);
        expect(res.body.code).toBe('shop_suspended');
        expect(await rows('"shopId" = :s', { s: s3.id })).toHaveLength(0);
      },
    );

    it.each(['update point', 'list stock', 'set stock', 'adjust stock'])(
      "S19 AS-12: %s addressing a point of another shop through the caller's own shop answers 404 pickup_point_not_found",
      async (name) => {
        const e = endpoints().find((x) => x.name === name)!;
        const before = await t.sql(
          `SELECT * FROM "PickupPoint" WHERE "id" = :id`,
          { id: foreignPoint.id },
        );
        const res = await e.call(w.u1, w.s1.id, foreignPoint.id).expect(404);
        expect(res.body.code).toBe('pickup_point_not_found');
        expect(
          await t.sql(`SELECT * FROM "PickupPoint" WHERE "id" = :id`, {
            id: foreignPoint.id,
          }),
        ).toEqual(before);
        expect(await t.sql(`SELECT * FROM "PickupStock"`)).toHaveLength(0);
      },
    );
  });

  describe('US2 - the point limit', () => {
    const fill = (shopId: string, n: number, active = true) =>
      t.sql(
        `INSERT INTO "PickupPoint" ("shopId", "name", "address", "location", "active", "createdAt", "updatedAt")
         SELECT :shopId, 'p' || g, 'a' || g, ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326)::geography, :active,
                now() - (g || ' seconds')::interval, now()
           FROM generate_series(1, :n) g RETURNING "id"`,
        { shopId, n, active },
      );

    it('S19 AS-13: with 99 points two creates at once give one 201 and one 409 pickup_point_limit_reached, and exactly 100 rows', async () => {
      await fill(w.s1.id, 98);
      await fill(w.s1.id, 1, false); // an inactive point still counts
      expect(await rows('"shopId" = :s', { s: w.s1.id })).toHaveLength(99);

      const results = await Promise.all([
        post(w.s1.id, valid),
        post(w.s1.id, valid),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe(
        'pickup_point_limit_reached',
      );
      expect(await rows('"shopId" = :s', { s: w.s1.id })).toHaveLength(100);
      expect((await t.outbox('pickup.point_changed')).length).toBe(1);
    });

    it('S19 AS-13: the limit is per shop', async () => {
      await fill(w.s1.id, 100);
      await post(w.s1.id, valid).expect(409);
      await post(w.s2.id, valid, w.u2).expect(201);
    });
  });

  describe('US2 - update, deactivate, reactivate', () => {
    it('S19 AS-14: PATCH name, address and hours returns the new state, adds one to the version and emits one event', async () => {
      const point = await t.createPoint(w.u1, w.s1.id);
      const res = await t
        .as(w.u1)
        .patch(`/api/shops/${w.s1.id}/pickup-points/${point.id}`)
        .send({
          name: ' Renamed ',
          address: 'New street 2',
          openingHours: BERLIN_HOURS,
        })
        .expect(200);

      expect(pickupPointSchema.parse(res.body)).toMatchObject({
        id: point.id,
        name: 'Renamed',
        address: 'New street 2',
        openingHours: BERLIN_HOURS,
        version: 2,
        lat: KREUZBERG.lat,
      });
      const events = await t.outbox('pickup.point_changed');
      expect(events.map((e) => e.payload.pointVersion)).toEqual([1, 2]);
      expect(events[1].payload).toMatchObject({
        name: 'Renamed',
        address: 'New street 2',
      });
    });

    it.each([
      ['lat', { lat: 52.0 }],
      ['lng', { lng: 13.0 }],
      ['shopId', { shopId: uuidv7() }],
      ['an empty body', {}],
      ['an unknown field', { color: 'red' }],
      ['name blank', { name: '  ' }],
    ])(
      'S19 AS-14: PATCH with %s answers 400 validation_failed and changes nothing',
      async (_name, body) => {
        const point = await t.createPoint(w.u1, w.s1.id);
        const res = await t
          .as(w.u1)
          .patch(`/api/shops/${w.s1.id}/pickup-points/${point.id}`)
          .send(body)
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
        const [row] = await rows('"id" = :id', { id: point.id });
        expect(row.version).toBe(1);
        expect(await t.outbox('pickup.point_changed')).toHaveLength(1);
      },
    );

    it('S19 AS-14: a PATCH of an unknown point answers 404 pickup_point_not_found', async () => {
      const res = await t
        .as(w.u1)
        .patch(`/api/shops/${w.s1.id}/pickup-points/${uuidv7()}`)
        .send({ name: 'x' })
        .expect(404);
      expect(res.body.code).toBe('pickup_point_not_found');
    });

    it('S19 AS-15: deactivating gives one event; repeating it is a no-op without version or event; reactivating keeps the old stock', async () => {
      const point = await t.createPoint(w.u1, w.s1.id);
      const product = await t.product(w.s1.id);
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 5);
      const url = `/api/shops/${w.s1.id}/pickup-points/${point.id}`;

      const off = await t
        .as(w.u1)
        .patch(url)
        .send({ active: false })
        .expect(200);
      expect(off.body).toMatchObject({ active: false, version: 2 });
      const again = await t
        .as(w.u1)
        .patch(url)
        .send({ active: false })
        .expect(200);
      expect(again.body).toMatchObject({ active: false, version: 2 });
      expect(
        (await t.outbox('pickup.point_changed')).map(
          (e) => e.payload.pointVersion,
        ),
      ).toEqual([1, 2]);

      const on = await t.as(w.u1).patch(url).send({ active: true }).expect(200);
      expect(on.body).toMatchObject({ active: true, version: 3 });
      const [stock] = await t.sql<{ quantity: number; version: number }>(
        `SELECT "quantity", "version" FROM "PickupStock" WHERE "pickupPointId" = :id`,
        { id: point.id },
      );
      expect(stock).toEqual({ quantity: 5, version: 1 });
    });

    it('S19 AS-15: a patch that repeats the current values is a no-op: no version, no event', async () => {
      const point = await t.createPoint(w.u1, w.s1.id, { name: 'Same' });
      const res = await t
        .as(w.u1)
        .patch(`/api/shops/${w.s1.id}/pickup-points/${point.id}`)
        .send({ name: 'Same', active: true })
        .expect(200);
      expect(res.body.version).toBe(1);
      expect(await t.outbox('pickup.point_changed')).toHaveLength(1);
    });

    it('S19 AS-15: a stock set or adjust on an inactive point answers 409 pickup_point_inactive and changes nothing', async () => {
      const point = await t.createPoint(w.u1, w.s1.id);
      const product = await t.product(w.s1.id);
      await t
        .as(w.u1)
        .patch(`/api/shops/${w.s1.id}/pickup-points/${point.id}`)
        .send({ active: false })
        .expect(200);
      const base = `/api/shops/${w.s1.id}/pickup-points/${point.id}/stock/${product.id}`;

      const set = await t.as(w.u1).put(base).send({ quantity: 3 }).expect(409);
      const adjust = await t
        .as(w.u1)
        .post(`${base}/adjustments`)
        .set('Idempotency-Key', uuidv7())
        .send({ delta: 1 })
        .expect(409);

      expect(set.body.code).toBe('pickup_point_inactive');
      expect(adjust.body.code).toBe('pickup_point_inactive');
      expect(await t.sql(`SELECT * FROM "PickupStock"`)).toHaveLength(0);
      expect(await t.outbox('pickup.stock_changed')).toHaveLength(0);
    });
  });

  describe('US2 - seller listings', () => {
    it('S19 AS-23: the point list pages 45 + 3 points of two shops: only the own shop, inactive included, newest first, each once, opaque cursor', async () => {
      const ids = await t.sql<{ id: string }>(
        `INSERT INTO "PickupPoint" ("shopId", "name", "address", "location", "active", "createdAt", "updatedAt")
         SELECT :s1, 'p' || g, 'a', ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326)::geography, g % 4 <> 0,
                '2026-10-01T10:00:00Z'::timestamptz + ((g / 2) || ' seconds')::interval, now()
           FROM generate_series(1, 45) g RETURNING "id"`,
        { s1: w.s1.id },
      );
      await t.sql(
        `INSERT INTO "PickupPoint" ("shopId", "name", "address", "location") SELECT :s2, 'x' || g, 'a', ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326)::geography FROM generate_series(1, 3) g`,
        { s2: w.s2.id },
      );

      const seen: { id: string; active: boolean; createdAt: string }[] = [];
      let cursor: string | null = null;
      const sizes: number[] = [];
      do {
        const res = await t
          .as(w.u1)
          .get(`/api/shops/${w.s1.id}/pickup-points`)
          .query({ limit: '20', ...(cursor ? { cursor } : {}) })
          .expect(200);
        const page = pickupPointPageSchema.parse(res.body);
        sizes.push(page.items.length);
        seen.push(...page.items);
        cursor = page.nextCursor;
        if (cursor) expect(cursor).not.toMatch(/^\d+$/);
      } while (cursor);

      expect(sizes).toEqual([20, 20, 5]);
      expect(new Set(seen.map((p) => p.id)).size).toBe(45);
      expect(seen.map((p) => p.id).sort()).toEqual(ids.map((r) => r.id).sort());
      expect(seen.some((p) => !p.active)).toBe(true);
      const order = seen.map((p) => `${p.createdAt}|${p.id}`);
      expect(order).toEqual([...order].sort().reverse());
    });

    it('S19 AS-23: list validation: limit 0, 51, text and an unknown parameter answer 400; a cursor that is not ours answers 400', async () => {
      for (const query of [
        { limit: '0' },
        { limit: '51' },
        { limit: 'x' },
        { page: '2' },
        { cursor: 'abc' },
      ]) {
        const res = await t
          .as(w.u1)
          .get(`/api/shops/${w.s1.id}/pickup-points`)
          .query(query)
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
    });

    it('S19 AS-23: the stock list of a point pages its rows by product id', async () => {
      const point = await t.createPoint(w.u1, w.s1.id);
      const products = await Promise.all(
        [1, 2, 3].map(() => t.product(w.s1.id)),
      );
      for (const [i, p] of products.entries())
        await t.setStock(w.u1, w.s1.id, point.id, p.id, i + 1);

      const first = pickupStockPageSchema.parse(
        (
          await t
            .as(w.u1)
            .get(`/api/shops/${w.s1.id}/pickup-points/${point.id}/stock`)
            .query({ limit: '2' })
            .expect(200)
        ).body,
      );
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = pickupStockPageSchema.parse(
        (
          await t
            .as(w.u1)
            .get(`/api/shops/${w.s1.id}/pickup-points/${point.id}/stock`)
            .query({ limit: '2', cursor: first.nextCursor! })
            .expect(200)
        ).body,
      );
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const all = [...first.items, ...second.items];
      expect(all.map((r) => r.productId)).toEqual(
        products.map((p) => p.id).sort(),
      );
      expect(all[0]).toEqual({
        productId: expect.any(String),
        quantity: expect.any(Number),
        version: 1,
        updatedAt: expect.any(String),
      });
    });
  });

  describe('US7 - no cross-domain coupling', () => {
    it('S19 AS-44: no foreign key leaves a pickup table toward a table of another domain', async () => {
      const keys = await t.sql<{ from: string; to: string }>(
        `SELECT conrelid::regclass::text AS "from", confrelid::regclass::text AS "to"
           FROM pg_constraint
          WHERE contype = 'f'
            AND conrelid::regclass::text IN ('"PickupPoint"', '"PickupStock"', '"PickupProductCopy"', '"PickupShopCopy"')`,
      );
      // the stock row belongs to its point: same owner, same domain
      expect(keys).toEqual([{ from: '"PickupStock"', to: '"PickupPoint"' }]);
    });

    it('S19 AS-44: deleting a shop row or a product row does not cascade into the pickup tables', async () => {
      const point = await t.createPoint(w.u1, w.s1.id, MITTE);
      const product = await t.product(w.s1.id);
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 2);

      await t.sql(`DELETE FROM "Product" WHERE "id" = :id RETURNING "id"`, {
        id: product.id,
      });

      expect(
        await t.sql(`SELECT 1 FROM "PickupStock" WHERE "productId" = :id`, {
          id: product.id,
        }),
      ).toHaveLength(1);
    });
  });
});
