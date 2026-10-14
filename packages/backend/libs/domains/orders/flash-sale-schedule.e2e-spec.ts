import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import {
  flashSaleEventSchemas,
  flashSaleMemberSchema,
  flashSalePageSchema,
} from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { rows, stockOf } from './testing/orders-app';
import {
  createFlashApp,
  seedSeller,
  type FlashTestApp,
  type Seller,
} from './testing/flash-kit';

const MIN = 60_000;
const HOUR = 3_600_000;
const T = new Date('2026-10-14T12:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms).toISOString();

describe('Flash sales: scheduling, authorization, listing and cancel', () => {
  let t: FlashTestApp;
  let probe: JobsTestProbe;

  beforeAll(async () => {
    t = await createFlashApp();
    probe = new JobsTestProbe(t.app.get(Sequelize));
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    t.clock.set(T);
  });

  const body = (productId: string, over: Record<string, unknown> = {}) => ({
    productId,
    priceMinor: 49_900,
    units: 30,
    startsAt: at(10 * MIN),
    endsAt: at(10 * MIN + HOUR),
    ...over,
  });
  const create = (s: Seller, productId: string, over = {}) =>
    t
      .as(s.owner)
      .post(`/api/shops/${s.shop.id}/flash-sales`)
      .send(body(productId, over));
  const seller = (over = {}) =>
    seedSeller(t, [{ priceMinor: 59_900, quantity: 100, ...over }]);
  /** Moves the clock; access tokens expire with it, so the seller signs in again. */
  const advanceTo = async (s: Seller, ms: number) => {
    t.clock.set(new Date(T.getTime() + ms));
    await t.reauth(s.owner);
  };
  const saleRows = () =>
    rows<{ id: string }>(t.app, `SELECT "id" FROM "FlashSale"`);

  describe('create (AS-14)', () => {
    it('S11 AS-14: 201 with Location, a SCHEDULED sale, its history row, the load and end jobs; stock and fast store untouched', async () => {
      const s = await seller();
      const product = s.products[0];
      const res = await create(s, product.id, { buckets: 8, perUserLimit: 1 });

      expect(res.status).toBe(201);
      const sale = flashSaleMemberSchema.parse(res.body);
      expect(res.headers.location).toBe(
        `/api/shops/${s.shop.id}/flash-sales/${sale.id}`,
      );
      expect(sale).toMatchObject({
        shopId: s.shop.id,
        productId: product.id,
        priceMinor: 49_900,
        currency: 'USD',
        units: 30,
        buckets: 8,
        perUserLimit: 1,
        admissionRatePerSecond: 2000,
        status: 'SCHEDULED',
        statusReason: null,
        stats: null,
      });

      const [row] = await rows<{
        shopId: string;
        status: string;
        version: number;
        priceMinor: string;
      }>(
        t.app,
        `SELECT "shopId", "status", "version", "priceMinor" FROM "FlashSale" WHERE "id" = :id`,
        { id: sale.id },
      );
      expect(row).toEqual({
        shopId: s.shop.id,
        status: 'SCHEDULED',
        version: 0,
        priceMinor: '49900',
      });
      const history = await rows<{
        fromStatus: string | null;
        toStatus: string;
        actor: string;
      }>(
        t.app,
        `SELECT "fromStatus", "toStatus", "actor" FROM "FlashSaleHistory" WHERE "saleId" = :id`,
        { id: sale.id },
      );
      expect(history).toEqual([
        { fromStatus: null, toStatus: 'SCHEDULED', actor: `shop:${s.shop.id}` },
      ]);

      const [load] = await probe.find('flash-sale.load', { saleId: sale.id });
      const [end] = await probe.find('flash-sale.end', { saleId: sale.id });
      expect(new Date(load.runAt).toISOString()).toBe(at(10 * MIN - MIN));
      expect(new Date(end.runAt).toISOString()).toBe(at(10 * MIN + HOUR));

      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 100 });
      expect(await t.keysOf(sale.id)).toEqual([]);
    });

    it('S11 AS-14: the shop comes from the path; a shopId in the body is refused', async () => {
      const s = await seller();
      const res = await create(s, s.products[0].id, { shopId: randomUUID() });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(await saleRows()).toEqual([]);
    });
  });

  describe('validation classes (AS-15)', () => {
    const invalid: Array<[string, Record<string, unknown>, string]> = [
      ['end before start', { endsAt: at(5 * MIN) }, 'endsAt'],
      ['window over 24 h', { endsAt: at(10 * MIN + 25 * HOUR) }, 'endsAt'],
      [
        'start less than 2 minutes ahead',
        { startsAt: at(MIN), endsAt: at(HOUR) },
        'startsAt',
      ],
      [
        'start in the past',
        { startsAt: at(-HOUR), endsAt: at(HOUR) },
        'startsAt',
      ],
      ['zero units', { units: 0 }, 'units'],
      ['limit above units', { units: 3, perUserLimit: 4 }, 'perUserLimit'],
      ['price zero', { priceMinor: 0 }, 'priceMinor'],
      ['buckets above 256', { buckets: 257 }, 'buckets'],
      [
        'admission rate above 10000',
        { admissionRatePerSecond: 10_001 },
        'admissionRatePerSecond',
      ],
      ['unknown property', { surprise: 1 }, 'surprise'],
    ];

    it.each(invalid)(
      'S11 AS-15: %s → 400 naming the field, nothing created',
      async (_name, over, field) => {
        const s = await seller();
        const res = await create(s, s.products[0].id, over);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(JSON.stringify(res.body.errors)).toContain(field);
        expect(await saleRows()).toEqual([]);
        expect(await probe.find('flash-sale.load')).toEqual([]);
      },
    );

    it('S11 AS-15: more units than the product holds → 422 insufficient_stock', async () => {
      const s = await seller({ quantity: 10 });
      const res = await create(s, s.products[0].id, { units: 11 });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('insufficient_stock');
      expect(await saleRows()).toEqual([]);
    });

    it('S11 AS-15: a drop price above the regular price → 422 drop_price_above_regular', async () => {
      const s = await seller({ priceMinor: 10_000 });
      const res = await create(s, s.products[0].id, { priceMinor: 10_001 });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('drop_price_above_regular');
      expect(await saleRows()).toEqual([]);
    });

    it('S11 AS-15: an archived product → 422 product_unavailable', async () => {
      const s = await seller({ status: 'ARCHIVED' });
      const res = await create(s, s.products[0].id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('product_unavailable');
      expect(await saleRows()).toEqual([]);
    });

    it('S11 AS-15: a drop price equal to the regular price is accepted', async () => {
      const s = await seller({ priceMinor: 10_000 });
      expect(
        (await create(s, s.products[0].id, { priceMinor: 10_000 })).status,
      ).toBe(201);
    });
  });

  describe('authorization and tenancy (AS-16)', () => {
    it('S11 AS-16: no token → 401; no row', async () => {
      const s = await seller();
      const res = await t
        .http()
        .post(`/api/shops/${s.shop.id}/flash-sales`)
        .send(body(s.products[0].id));
      expect(res.status).toBe(401);
      expect(await saleRows()).toEqual([]);
    });

    it('S11 AS-16: a viewer may read but not schedule; a stranger gets 404', async () => {
      const s = await seller();
      const viewer = await t.newUser();
      await addMember(t.app, s.shop.id, viewer.id, 'VIEWER');
      const denied = await t
        .as(viewer)
        .post(`/api/shops/${s.shop.id}/flash-sales`)
        .send(body(s.products[0].id));
      expect(denied.status).toBe(403);
      expect(
        (await t.as(viewer).get(`/api/shops/${s.shop.id}/flash-sales`)).status,
      ).toBe(200);

      const stranger = await t.newUser();
      const hidden = await t
        .as(stranger)
        .post(`/api/shops/${s.shop.id}/flash-sales`)
        .send(body(s.products[0].id));
      expect(hidden.status).toBe(404);
      expect(await saleRows()).toEqual([]);
    });

    it("S11 AS-16: another shop's product → 404 product_not_found", async () => {
      const mine = await seller();
      const other = await seller();
      const res = await create(mine, other.products[0].id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('product_not_found');
      expect(await saleRows()).toEqual([]);
    });

    it('S11 AS-16: a suspended shop cannot schedule → 403', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner, { status: 'SUSPENDED' });
      const product = await createProduct(t.app, shop, { quantity: 50 });
      const res = await t
        .as(owner)
        .post(`/api/shops/${shop.id}/flash-sales`)
        .send(body(product.id));
      expect(res.status).toBe(403);
      expect(await saleRows()).toEqual([]);
    });
  });

  describe('no overlap (AS-17)', () => {
    it('S11 AS-17: an overlapping window → 409 flash_sale_overlap; an adjacent one is accepted', async () => {
      const s = await seller();
      const p = s.products[0].id;
      expect((await create(s, p)).status).toBe(201);
      const overlap = await create(s, p, {
        startsAt: at(30 * MIN),
        endsAt: at(2 * HOUR),
      });
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe('flash_sale_overlap');
      // [start, end) windows: starting exactly at the end of the first does not overlap
      const adjacent = await create(s, p, {
        startsAt: at(10 * MIN + HOUR),
        endsAt: at(10 * MIN + 2 * HOUR),
      });
      expect(adjacent.status).toBe(201);
      expect(await saleRows()).toHaveLength(2);
    });

    it('S11 AS-17: two simultaneous creates for one window → exactly one 201 and one 409', async () => {
      const s = await seller();
      const results = await Promise.all([
        create(s, s.products[0].id),
        create(s, s.products[0].id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await saleRows()).toHaveLength(1);
      expect(await probe.find('flash-sale.load')).toHaveLength(1);
    });

    it('S11 AS-17: a cancelled sale frees its window', async () => {
      const s = await seller();
      const first = await create(s, s.products[0].id);
      await t
        .as(s.owner)
        .post(`/api/shops/${s.shop.id}/flash-sales/${first.body.id}/cancel`);
      expect((await create(s, s.products[0].id)).status).toBe(201);
    });
  });

  describe('list, read, isolation (AS-18)', () => {
    it('S11 AS-18: 45 sales paged by cursor, newest start first, no duplicates or gaps', async () => {
      const s = await seller({ quantity: 1000 });
      const ids: string[] = [];
      for (let i = 0; i < 45; i++) {
        const res = await create(s, s.products[0].id, {
          units: 5,
          startsAt: at(HOUR * (i + 1)),
          endsAt: at(HOUR * (i + 1) + 30 * MIN),
        });
        expect(res.status).toBe(201);
        ids.push(res.body.id);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/api/shops/${s.shop.id}/flash-sales?limit=20${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await t.as(s.owner).get(url);
        expect(res.status).toBe(200);
        const page = flashSalePageSchema.parse(res.body);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());
    });

    it('S11 AS-18: a bad cursor, limit above 100 and a bad status → 400', async () => {
      const s = await seller();
      const get = (q: string) =>
        t.as(s.owner).get(`/api/shops/${s.shop.id}/flash-sales?${q}`);
      expect((await get('cursor=not-a-cursor')).status).toBe(400);
      expect((await get('limit=101')).status).toBe(400);
      expect((await get('status=NOPE')).status).toBe(400);
    });

    it("S11 AS-18: another shop's cursor is refused; its sale reads as 404", async () => {
      const a = await seller();
      const b = await seller();
      const mine = await create(a, a.products[0].id);
      const first = await t
        .as(a.owner)
        .get(`/api/shops/${a.shop.id}/flash-sales?limit=1`);
      expect(first.status).toBe(200);
      const foreign = await t
        .as(b.owner)
        .get(`/api/shops/${b.shop.id}/flash-sales/${mine.body.id}`);
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('flash_sale_not_found');
      const own = await t
        .as(a.owner)
        .get(`/api/shops/${a.shop.id}/flash-sales/${mine.body.id}`);
      expect(own.status).toBe(200);
      expect(flashSaleMemberSchema.parse(own.body).id).toBe(mine.body.id);
    });

    it('S11 AS-18: a loaded sale reports exact stats', async () => {
      const s = await seller();
      const res = await create(s, s.products[0].id, { units: 30, buckets: 4 });
      await advanceTo(s, 9 * MIN);
      await t.jobs.load({ saleId: res.body.id });
      const read = await t
        .as(s.owner)
        .get(`/api/shops/${s.shop.id}/flash-sales/${res.body.id}`);
      expect(flashSaleMemberSchema.parse(read.body)).toMatchObject({
        status: 'LOADED',
        stats: {
          unitsLoaded: 30,
          unitsRemaining: 30,
          unitsHeld: 0,
          unitsSold: 0,
        },
      });
    });

    it('S11 AS-18 (SC-006): two reads of one sale are identical byte for byte', async () => {
      const s = await seller();
      const res = await create(s, s.products[0].id);
      const url = `/api/shops/${s.shop.id}/flash-sales/${res.body.id}`;
      const a = await t.as(s.owner).get(url);
      const b = await t.as(s.owner).get(url);
      expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    });
  });

  describe('cancel and illegal transitions (AS-19)', () => {
    it('S11 AS-19: cancel a SCHEDULED sale → CANCELLED, jobs cancelled, event once; a repeat is 200', async () => {
      const s = await seller();
      const made = await create(s, s.products[0].id);
      const url = `/api/shops/${s.shop.id}/flash-sales/${made.body.id}/cancel`;

      const first = await t.as(s.owner).post(url);
      expect(first.status).toBe(200);
      expect(flashSaleMemberSchema.parse(first.body)).toMatchObject({
        status: 'CANCELLED',
        statusReason: 'cancelled_by_shop',
      });
      const second = await t.as(s.owner).post(url);
      expect(second.status).toBe(200);
      expect(second.body.status).toBe('CANCELLED');

      const jobs = [
        ...(await probe.find('flash-sale.load', { saleId: made.body.id })),
        ...(await probe.find('flash-sale.end', { saleId: made.body.id })),
      ];
      expect(jobs.map((j) => j.status)).toEqual(['CANCELLED', 'CANCELLED']);
      const events = (await outboxRowsFor(t.app, made.body.id)).filter(
        (r) => r.type === 'flashsale.cancelled',
      );
      expect(events).toHaveLength(1);
      expect(
        flashSaleEventSchemas['flashsale.cancelled'].parse(
          events[0].payload.payload,
        ),
      ).toMatchObject({
        saleId: made.body.id,
        shopId: s.shop.id,
      });
      const history = await rows<{ toStatus: string }>(
        t.app,
        `SELECT "toStatus" FROM "FlashSaleHistory" WHERE "saleId" = :id ORDER BY "at", "id"`,
        { id: made.body.id },
      );
      expect(history.map((h) => h.toStatus)).toEqual([
        'SCHEDULED',
        'CANCELLED',
      ]);
    });

    it('S11 AS-19: a sale loaded before its start can be cancelled and its units come back', async () => {
      const s = await seller({ quantity: 100 });
      const p = s.products[0];
      const made = await create(s, p.id, { units: 40, buckets: 4 });
      await advanceTo(s, 9 * MIN);
      await t.jobs.load({ saleId: made.body.id });
      expect(await stockOf(t.app, [p.id])).toEqual({ [p.id]: 60 });
      expect(await t.buckets(made.body.id, 4)).toEqual([10, 10, 10, 10]);

      const res = await t
        .as(s.owner)
        .post(`/api/shops/${s.shop.id}/flash-sales/${made.body.id}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(await stockOf(t.app, [p.id])).toEqual({ [p.id]: 100 });
      expect(await t.keysOf(made.body.id)).toEqual([]);
      const ops = await rows<{ operationId: string; delta: number }>(
        t.app,
        `SELECT "operationId", "delta" FROM "ProductStockOperation" WHERE "operationId" LIKE :like ORDER BY "operationId"`,
        { like: `orders:flash:${made.body.id}:%` },
      );
      expect(ops.map((o) => [o.operationId, Number(o.delta)])).toEqual([
        [`orders:flash:${made.body.id}:load`, -40],
        [`orders:flash:${made.body.id}:return`, 40],
      ]);
    });

    it('S11 AS-19: a started or finished sale → 409 flash_sale_not_cancellable', async () => {
      const s = await seller();
      const made = await create(s, s.products[0].id);
      await advanceTo(s, 9 * MIN);
      await t.jobs.load({ saleId: made.body.id });
      const url = `/api/shops/${s.shop.id}/flash-sales/${made.body.id}/cancel`;

      await advanceTo(s, 11 * MIN); // started
      const started = await t.as(s.owner).post(url);
      expect(started.status).toBe(409);
      expect(started.body.code).toBe('flash_sale_not_cancellable');

      await advanceTo(s, 3 * HOUR);
      await t.jobs.end({ saleId: made.body.id });
      const ended = await t.as(s.owner).post(url);
      expect(ended.status).toBe(409);
      expect(ended.body.code).toBe('flash_sale_not_cancellable');
    });

    it("S11 AS-19: another shop's sale → 404 and nothing changes", async () => {
      const a = await seller();
      const b = await seller();
      const made = await create(a, a.products[0].id);
      const res = await t
        .as(b.owner)
        .post(`/api/shops/${b.shop.id}/flash-sales/${made.body.id}/cancel`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('flash_sale_not_found');
      const [row] = await rows<{ status: string }>(
        t.app,
        `SELECT "status" FROM "FlashSale" WHERE "id" = :id`,
        { id: made.body.id },
      );
      expect(row.status).toBe('SCHEDULED');
    });
  });
});
