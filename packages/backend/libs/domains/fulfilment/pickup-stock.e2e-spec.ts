import { v7 as uuidv7 } from 'uuid';
import {
  pickupStockAdjustedSchema,
  pickupStockSchema,
} from '@marketplace-sandbox/contracts';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { recordStatements } from '@app/test/utils/catalog-fixtures';
import { PickupAvailabilityService } from './application/pickup-availability.service';
import {
  InvalidAvailabilityRequestError,
  PickupPointNotFoundError,
} from './domain/pickup-errors';
import {
  createPickupApp,
  KREUZBERG,
  type PickupTestApp,
  type PickupWorld,
} from './testing/pickup-fixtures';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Pickup stock: set, adjust, idempotency, concurrency and exact check', () => {
  let t: PickupTestApp;
  let w: PickupWorld;
  let point: { id: string };
  let product: { id: string };

  beforeAll(async () => {
    t = await createPickupApp();
  });
  afterAll(() => t.close());
  afterEach(() => jest.restoreAllMocks());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
    point = await t.createPoint(w.u1, w.s1.id, KREUZBERG);
    product = await t.product(w.s1.id, { title: 'AirPods Pro 3' });
  });

  const base = (productId = product.id, pointId = point.id, shopId = w.s1.id) =>
    `/api/shops/${shopId}/pickup-points/${pointId}/stock/${productId}`;
  const put = (body: unknown, url = base(), user = w.u1) =>
    t
      .as(user)
      .put(url)
      .send(body as object);
  const adjust = (
    delta: unknown,
    key: string | null = uuidv7(),
    url = base(),
  ) => {
    const req = t.as(w.u1).post(`${url}/adjustments`);
    if (key) req.set('Idempotency-Key', key);
    return req.send({ delta } as object);
  };
  const stockRows = () =>
    t.sql<{ quantity: number; version: number }>(
      `SELECT "quantity", "version" FROM "PickupStock" WHERE "pickupPointId" = :p AND "productId" = :pr`,
      { p: point.id, pr: product.id },
    );
  const stockEvents = () => t.outbox('pickup.stock_changed');

  describe('US2 - set stock', () => {
    it('S19 AS-16: a set returns the row, writes it and one stock_changed event in the same transaction; a second set gives version 2 and a second event', async () => {
      const res = await put({ quantity: 4 }).expect(200);

      expect(pickupStockSchema.parse(res.body)).toEqual({
        pickupPointId: point.id,
        productId: product.id,
        quantity: 4,
        version: 1,
      });
      expect(await stockRows()).toEqual([{ quantity: 4, version: 1 }]);
      const events = await stockEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateId: `${point.id}:${product.id}`,
        aggregateVersion: 1,
        payload: {
          pickupPointId: point.id,
          productId: product.id,
          shopId: w.s1.id,
          quantity: 4,
          stockVersion: 1,
          lat: KREUZBERG.lat,
          lng: KREUZBERG.lng,
        },
      });

      const second = await put({ quantity: 9 }).expect(200);
      expect(second.body.version).toBe(2);
      expect((await stockEvents()).map((e) => e.payload.stockVersion)).toEqual([
        1, 2,
      ]);
    });

    it('S19 AS-17: repeating the same quantity changes nothing: same version, no new event, no row change', async () => {
      await put({ quantity: 3 }).expect(200);
      await put({ quantity: 4 }).expect(200);
      const [before] = await t.sql(`SELECT * FROM "PickupStock"`);

      const again = await put({ quantity: 4 }).expect(200);

      expect(again.body).toMatchObject({ quantity: 4, version: 2 });
      expect(await t.sql(`SELECT * FROM "PickupStock"`)).toEqual([before]);
      expect(await stockEvents()).toHaveLength(2);
    });
  });

  describe('US2 - validation and ownership', () => {
    it.each([
      ['negative', { quantity: -1 }],
      ['fractional', { quantity: 1.5 }],
      ['missing', {}],
      ['a string', { quantity: '4' }],
      ['null', { quantity: null }],
      ['above 1 000 000', { quantity: 1_000_001 }],
      ['an unknown field', { quantity: 1, note: 'x' }],
      ['a negative expectedVersion', { quantity: 1, expectedVersion: -1 }],
      ['a fractional expectedVersion', { quantity: 1, expectedVersion: 1.5 }],
    ])(
      'S19 AS-18: a quantity that is %s answers 400 validation_failed and writes nothing',
      async (_name, body) => {
        const res = await put(body).expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await stockRows()).toHaveLength(0);
        expect(await stockEvents()).toHaveLength(0);
      },
    );

    it('S19 AS-18: the largest quantity, 1 000 000, is accepted', async () => {
      await put({ quantity: 1_000_000 }).expect(200);
      expect(await stockRows()).toEqual([{ quantity: 1_000_000, version: 1 }]);
    });

    it('S19 AS-18: a product of another shop (A1, cross-tenant write) and an unknown product answer 404 product_not_found and write no row', async () => {
      const foreign = await t.product(w.s2.id);
      for (const productId of [foreign.id, uuidv7()]) {
        const res = await put({ quantity: 2 }, base(productId)).expect(404);
        expect(res.body.code).toBe('product_not_found');
      }
      expect(await t.sql(`SELECT * FROM "PickupStock"`)).toHaveLength(0);
      expect(await stockEvents()).toHaveLength(0);
    });

    it('S19 AS-18: an unknown point and a point of another shop answer 404 pickup_point_not_found; a product id that is not a UUID answers 400', async () => {
      const foreignPoint = await t.createPoint(w.u2, w.s2.id);
      for (const pointId of [uuidv7(), foreignPoint.id]) {
        const res = await put(
          { quantity: 2 },
          base(product.id, pointId),
        ).expect(404);
        expect(res.body.code).toBe('pickup_point_not_found');
      }
      await put({ quantity: 2 }, base('not-a-uuid')).expect(400);
      expect(await t.sql(`SELECT * FROM "PickupStock"`)).toHaveLength(0);
    });

    it('S19 AS-18: an archived product of the shop accepts stock', async () => {
      const archived = await t.product(w.s1.id, { status: 'ARCHIVED' });
      await put({ quantity: 2 }, base(archived.id)).expect(200);
      expect(
        await t.sql(`SELECT * FROM "PickupStock" WHERE "productId" = :id`, {
          id: archived.id,
        }),
      ).toHaveLength(1);
    });

    it('S19 AS-18: a stock write seeds the product copy from the catalog read', async () => {
      await put({ quantity: 2 }).expect(200);
      const [copy] = await t.sql<{
        title: string;
        status: string;
        version: string;
      }>(
        `SELECT "title", "status", "version" FROM "PickupProductCopy" WHERE "productId" = :id`,
        { id: product.id },
      );
      expect(copy).toMatchObject({ title: 'AirPods Pro 3', status: 'ACTIVE' });
    });
  });

  describe('US2 - optimistic version', () => {
    it('S19 AS-19: a stale expectedVersion answers 409 stock_version_conflict with currentVersion and changes nothing', async () => {
      await put({ quantity: 1 });
      await put({ quantity: 2 });
      await put({ quantity: 3 }); // version 3

      const res = await put({ quantity: 1, expectedVersion: 2 }).expect(409);

      expect(res.body).toMatchObject({
        code: 'stock_version_conflict',
        currentVersion: 3,
      });
      expect(await stockRows()).toEqual([{ quantity: 3, version: 3 }]);
      expect(await stockEvents()).toHaveLength(3);
    });

    it('S19 AS-19: two sets with the same expectedVersion at once: exactly one 200 (version 4) and one 409', async () => {
      await put({ quantity: 1 });
      await put({ quantity: 2 });
      await put({ quantity: 3 });

      const results = await Promise.all([
        put({ quantity: 10, expectedVersion: 3 }),
        put({ quantity: 20, expectedVersion: 3 }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 200)?.body.version).toBe(4);
      expect((await stockRows())[0].version).toBe(4);
      expect(await stockEvents()).toHaveLength(4);
    });

    it('S19 AS-19: expectedVersion 0 creates the row at version 1; with a row it conflicts', async () => {
      const created = await put({ quantity: 5, expectedVersion: 0 }).expect(
        200,
      );
      expect(created.body.version).toBe(1);
      const res = await put({ quantity: 6, expectedVersion: 0 }).expect(409);
      expect(res.body.currentVersion).toBe(1);
    });

    it('S19 AS-19: two creates with expectedVersion 0 at once: one 200 and one 409', async () => {
      const results = await Promise.all([
        put({ quantity: 5, expectedVersion: 0 }),
        put({ quantity: 6, expectedVersion: 0 }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('S19 AS-19: without expectedVersion every accepted write gets a unique, increasing version', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((q) => put({ quantity: q })),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(results.map((r) => r.body.version).sort()).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(
        (await stockEvents()).map((e) => e.payload.stockVersion).sort(),
      ).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('US2 - adjustments and retry safety', () => {
    beforeEach(async () => {
      await put({ quantity: 5 });
    });

    it('S19 AS-20: the first call applies; a replay returns the stored answer with Idempotency-Replayed and changes nothing', async () => {
      const key = uuidv7();
      const first = await adjust(-1, key).expect(200);

      expect(pickupStockAdjustedSchema.parse(first.body)).toEqual({
        pickupPointId: point.id,
        productId: product.id,
        quantity: 4,
        version: 2,
        applied: true,
      });
      expect(first.headers['idempotency-replayed']).toBeUndefined();

      const replay = await adjust(-1, key).expect(200);

      expect(replay.body).toEqual(first.body);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(await stockRows()).toEqual([{ quantity: 4, version: 2 }]);
      expect(await stockEvents()).toHaveLength(2);
    });

    it('S19 AS-20: the same key with another body answers 422; a missing key answers 422', async () => {
      const key = uuidv7();
      await adjust(-1, key).expect(200);

      await adjust(-2, key).expect(422);
      const missing = await adjust(-1, null).expect(422);

      expect(missing.body.code).toBe('idempotency_key_required');
      expect(await stockRows()).toEqual([{ quantity: 4, version: 2 }]);
    });

    it('S19 AS-20: a request with the same key while the first is still running answers 409', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const outbox = t.app.get(OutboxService);
      const original = outbox.append.bind(outbox);
      jest.spyOn(outbox, 'append').mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return original(...args);
      });
      const key = uuidv7();

      const first = adjust(-1, key).then((r) => r);
      await inside;
      const second = await adjust(-1, key).expect(409);
      release();

      expect(second.body.code).toBe('idempotency_in_flight');
      expect((await first).status).toBe(200);
      expect(await stockRows()).toEqual([{ quantity: 4, version: 2 }]);
    });

    it('S19 AS-20: after 24 hours the key is free again', async () => {
      const key = uuidv7();
      await adjust(-1, key).expect(200);
      t.clock.advance(DAY_MS + 60_000);
      await t.reauth(w.u1); // the session token expired with the moved clock

      const again = await adjust(-1, key).expect(200);

      expect(again.headers['idempotency-replayed']).toBeUndefined();
      expect(await stockRows()).toEqual([{ quantity: 3, version: 3 }]);
    });

    it.each([
      ['zero', 0],
      ['fractional', 1.5],
      ['above 100 000', 100_001],
      ['below -100 000', -100_001],
      ['a string', '1'],
      ['null', null],
      ['missing', undefined],
    ])(
      'S19 AS-20: a delta that is %s answers 400 validation_failed',
      async (_name, delta) => {
        const res = await adjust(delta).expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await stockRows()).toEqual([{ quantity: 5, version: 1 }]);
      },
    );

    it('S19 AS-20: an adjustment creates the row for a product with no stock yet when the delta is positive', async () => {
      const other = await t.product(w.s1.id);
      const res = await adjust(3, uuidv7(), base(other.id)).expect(200);
      expect(res.body).toMatchObject({
        quantity: 3,
        version: 1,
        applied: true,
      });
    });
  });

  describe('US2 - never below zero, concurrent', () => {
    it('S19 AS-21: stock 5 and ten parallel -1 with different keys: five 200, five 409 insufficient_pickup_stock {available: 0}, final 0, versions 2…6, five events', async () => {
      await put({ quantity: 5 });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => adjust(-1)),
      );

      const ok = results.filter((r) => r.status === 200);
      const refused = results.filter((r) => r.status === 409);
      expect(ok).toHaveLength(5);
      expect(refused).toHaveLength(5);
      for (const r of refused)
        expect(r.body).toMatchObject({
          code: 'insufficient_pickup_stock',
          available: 0,
        });
      expect(ok.map((r) => r.body.version).sort()).toEqual([2, 3, 4, 5, 6]);
      expect(await stockRows()).toEqual([{ quantity: 0, version: 6 }]);
      expect(
        (await stockEvents()).filter(
          (e) => (e.payload.stockVersion as number) > 1,
        ),
      ).toHaveLength(5);
    });

    it('S19 AS-21: a decrement below the stock answers 409 with the available quantity and changes nothing', async () => {
      await put({ quantity: 2 });
      const res = await adjust(-3).expect(409);
      expect(res.body).toMatchObject({
        code: 'insufficient_pickup_stock',
        available: 2,
      });
      expect(await stockRows()).toEqual([{ quantity: 2, version: 1 }]);
    });

    it('S19 AS-21: a +1 above 1 000 000 answers 409 stock_limit_exceeded and changes nothing', async () => {
      await put({ quantity: 1_000_000 });
      const res = await adjust(1).expect(409);
      expect(res.body.code).toBe('stock_limit_exceeded');
      expect(await stockRows()).toEqual([{ quantity: 1_000_000, version: 1 }]);
      expect(await stockEvents()).toHaveLength(1);
    });
  });

  describe('US4 - the exact check at reservation time', () => {
    let availability: PickupAvailabilityService;
    beforeEach(() => {
      availability = t.app.get(PickupAvailabilityService);
    });

    it('S19 AS-32: a change to 0 that is committed but not consumed still shows in search, while checkAvailability reports the shortage at once', async () => {
      await t.activateShop(w.s1.id);
      await put({ quantity: 2 });
      await t.consume();
      await put({ quantity: 0 }); // committed; the consumers do not run

      const shown = await t
        .http()
        .get('/api/search/near')
        .query({ lat: KREUZBERG.lat, lng: KREUZBERG.lng })
        .expect(200);
      expect(
        shown.body.items.map((i: { productId: string }) => i.productId),
      ).toEqual([product.id]);

      expect(
        await availability.checkAvailability(point.id, [
          { productId: product.id, quantity: 1 },
        ]),
      ).toEqual({
        available: false,
        shortages: [{ productId: product.id, requested: 1, available: 0 }],
      });
    });

    it('S19 AS-33: the exact answer for a match, shortages in request order (a zero row and a missing row alike), an inactive point and an unknown point', async () => {
      const [b, c] = await Promise.all([
        t.product(w.s1.id),
        t.product(w.s1.id),
      ]);
      await put({ quantity: 3 });
      await put({ quantity: 0 }, base(b.id));

      expect(
        await availability.checkAvailability(point.id, [
          { productId: product.id, quantity: 2 },
        ]),
      ).toEqual({
        available: true,
        shortages: [],
      });
      expect(
        await availability.checkAvailability(point.id, [
          { productId: product.id, quantity: 5 },
          { productId: b.id, quantity: 1 },
          { productId: c.id, quantity: 1 },
        ]),
      ).toEqual({
        available: false,
        shortages: [
          { productId: product.id, requested: 5, available: 3 },
          { productId: b.id, requested: 1, available: 0 },
          { productId: c.id, requested: 1, available: 0 },
        ],
      });
      await t
        .as(w.u1)
        .patch(`/api/shops/${w.s1.id}/pickup-points/${point.id}`)
        .send({ active: false })
        .expect(200);
      expect(
        await availability.checkAvailability(point.id, [
          { productId: product.id, quantity: 1 },
        ]),
      ).toEqual({
        available: false,
        reason: 'pickup_point_inactive',
        shortages: [],
      });
      await expect(
        availability.checkAvailability(uuidv7(), [
          { productId: product.id, quantity: 1 },
        ]),
      ).rejects.toBeInstanceOf(PickupPointNotFoundError);
    });

    it('S19 AS-33: the whole batch is one statement', async () => {
      await put({ quantity: 3 });
      const lines = [
        { productId: product.id, quantity: 1 },
        ...(await Promise.all([1, 2, 3].map(() => t.product(w.s1.id)))).map(
          (p) => ({ productId: p.id, quantity: 1 }),
        ),
      ];

      const { statements } = await recordStatements(
        t.app,
        () => availability.checkAvailability(point.id, lines),
        /./,
      );

      expect(statements.filter((s) => /PickupStock/.test(s))).toHaveLength(1);
      expect(statements).toHaveLength(1);
    });

    it.each([
      ['no lines', []],
      [
        '51 lines',
        Array.from({ length: 51 }, () => ({
          productId: uuidv7(),
          quantity: 1,
        })),
      ],
      ['a quantity below 1', [{ productId: uuidv7(), quantity: 0 }]],
      ['a fractional quantity', [{ productId: uuidv7(), quantity: 1.5 }]],
      ['a product id that is not a UUID', [{ productId: 'abc', quantity: 1 }]],
      [
        'duplicate products',
        (() => {
          const id = uuidv7();
          return [
            { productId: id, quantity: 1 },
            { productId: id, quantity: 2 },
          ];
        })(),
      ],
    ])(
      'S19 AS-33: %s throws InvalidAvailabilityRequestError',
      async (_name, lines) => {
        await expect(
          availability.checkAvailability(point.id, lines as never),
        ).rejects.toBeInstanceOf(InvalidAvailabilityRequestError);
      },
    );

    it('S19 AS-33: fifty lines are accepted', async () => {
      const lines = Array.from({ length: 50 }, () => ({
        productId: uuidv7(),
        quantity: 1,
      }));
      const answer = await availability.checkAvailability(point.id, lines);
      expect(answer.shortages).toHaveLength(50);
    });
  });

  describe('US2 - atomic with its event', () => {
    it('S19 AS-22: a failing outbox append leaves the row unchanged, no event, a generic 503, and a retry with the same key succeeds once', async () => {
      await put({ quantity: 5 });
      const outbox = t.app.get(OutboxService);
      jest
        .spyOn(outbox, 'append')
        .mockRejectedValueOnce(
          new Error('relation "Outbox" is broken: secret internals'),
        );
      const key = uuidv7();

      const failed = await adjust(-1, key).expect(503);

      expect(failed.body.code).toBe('service_unavailable');
      expect(JSON.stringify(failed.body)).not.toMatch(/Outbox|secret|relation/);
      expect(await stockRows()).toEqual([{ quantity: 5, version: 1 }]);
      expect(await stockEvents()).toHaveLength(1);

      const retry = await adjust(-1, key).expect(200);
      expect(retry.headers['idempotency-replayed']).toBeUndefined();
      expect(await stockRows()).toEqual([{ quantity: 4, version: 2 }]);
      expect(await stockEvents()).toHaveLength(2);
      const again = await adjust(-1, key).expect(200);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(await stockRows()).toEqual([{ quantity: 4, version: 2 }]);
    });

    it('S19 AS-22: a failing outbox append during a set leaves no row and no event', async () => {
      jest
        .spyOn(t.app.get(OutboxService), 'append')
        .mockRejectedValueOnce(new Error('boom'));
      await put({ quantity: 5 }).expect(503);
      expect(await stockRows()).toHaveLength(0);
      expect(await stockEvents()).toHaveLength(0);
    });
  });
});
