import { randomUUID } from 'node:crypto';
import {
  auctionEventSchemas,
  auctionMemberSchema,
  auctionPageSchema,
} from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import {
  createAuctionsApp,
  exec,
  rows,
  seedAuction,
  seedSeller,
  stockOf,
  type AuctionTestApp,
  type Seller,
} from './testing/auction-app';

const MIN = 60_000;
const T = new Date('2026-10-14T12:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms).toISOString();

describe('Auctions: scheduling, authorization, listing and cancel', () => {
  let t: AuctionTestApp;

  beforeAll(async () => {
    t = await createAuctionsApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await t.setTime(new Date(T.getTime() - 5 * MIN));
  });

  const body = (productId: string, over: Record<string, unknown> = {}) => ({
    productId,
    title: 'Signed #001/100',
    startingPriceMinor: 1000,
    minIncrementMinor: 500,
    reservePriceMinor: 3000,
    startsAt: at(0),
    endsAt: at(60 * MIN),
    ...over,
  });
  const create = (
    s: Seller,
    productId: string,
    over: Record<string, unknown> = {},
    key: string = `create-${randomUUID()}`,
  ) =>
    t
      .as(s.owner)
      .post(`/api/shops/${s.shop.id}/auctions`)
      .set('Idempotency-Key', key)
      .send(body(productId, over));
  const seller = (over = {}) =>
    seedSeller(t, [{ priceMinor: 20_000, quantity: 3, ...over }]);
  const auctionRows = () =>
    rows<{ id: string; status: string }>(
      t.app,
      `SELECT "id", "status" FROM "Auction"`,
    );
  const auctionRow = async (id: string) =>
    (
      await rows<{
        status: string;
        statusReason: string | null;
        version: number;
        unitHeld: boolean;
        returnPending: boolean;
        priceMinor: string;
        bidCount: number;
      }>(
        t.app,
        `SELECT "status", "statusReason", "version", "unitHeld", "returnPending", "priceMinor", "bidCount" FROM "Auction" WHERE "id" = :id`,
        { id },
      )
    )[0];
  const historyOf = (id: string) =>
    rows<{
      fromStatus: string | null;
      toStatus: string;
      reason: string | null;
      auctionVersion: number;
    }>(
      t.app,
      `SELECT "fromStatus", "toStatus", "reason", "auctionVersion" FROM "AuctionHistory" WHERE "auctionId" = :id ORDER BY "auctionVersion", "at"`,
      { id },
    );
  const stockOps = (id: string) =>
    rows<{ operationId: string; delta: number; reason: string }>(
      t.app,
      `SELECT "operationId", "delta", "reason" FROM "ProductStockOperation" WHERE "operationId" LIKE :like ORDER BY "operationId"`,
      { like: `auctions:${id}:%` },
    );
  const eventTypes = async (id: string) =>
    (await outboxRowsFor(t.app, id)).map((r) => r.type);
  const nothingWritten = async (productId: string, expectedStock: number) => {
    expect(await auctionRows()).toEqual([]);
    expect(
      await rows(t.app, `SELECT 1 FROM "Outbox" WHERE "type" LIKE 'auction.%'`),
    ).toEqual([]);
    expect(await t.probe.find('auctions.open')).toEqual([]);
    expect(await t.probe.find('auctions.close')).toEqual([]);
    expect(await t.probe.find('auctions.hold-stock')).toEqual([]);
    expect(await stockOf(t.app, [productId])).toEqual({
      [productId]: expectedStock,
    });
  };
  /** Creates an auction that is `OPEN` at `T` (created five minutes earlier, the unit held, the open job run). */
  const openAuction = async (s: Seller, over: Record<string, unknown> = {}) => {
    const res = await create(s, s.products[0].id, over);
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    await t.setTime(T);
    await t.jobs.open({ auctionId: id });
    return id;
  };

  describe('create (AS-01)', () => {
    it('S21 AS-01: 201 with Location, a SCHEDULED auction, its history row, the event, three jobs and the unit held once', async () => {
      const s = await seller();
      const product = s.products[0];
      const res = await create(s, product.id);

      expect(res.status).toBe(201);
      const auction = auctionMemberSchema.parse(res.body);
      expect(res.headers.location).toBe(
        `/api/shops/${s.shop.id}/auctions/${auction.id}`,
      );
      expect(auction).toMatchObject({
        shopId: s.shop.id,
        productId: product.id,
        status: 'SCHEDULED',
        statusReason: null,
        currency: 'EUR',
        reservePriceMinor: 3000,
        bidCount: 0,
        priceMinor: 1000,
        startsAt: at(0),
        endsAt: at(60 * MIN),
        originalEndsAt: at(60 * MIN),
      });

      expect(await auctionRows()).toHaveLength(1);
      expect(await auctionRow(auction.id)).toMatchObject({
        status: 'SCHEDULED',
        version: 1,
        unitHeld: true,
        returnPending: false,
      });
      expect(await historyOf(auction.id)).toEqual([
        {
          fromStatus: null,
          toStatus: 'SCHEDULED',
          reason: null,
          auctionVersion: 1,
        },
      ]);
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 2 });
      expect(await stockOps(auction.id)).toEqual([
        {
          operationId: `auctions:${auction.id}:hold`,
          delta: -1,
          reason: 'auction.hold',
        },
      ]);
      const events = await outboxRowsFor(t.app, auction.id);
      expect(events.map((e) => e.type)).toEqual(['auction.created']);
      const payload = (events[0].payload as { payload: unknown }).payload;
      expect(
        auctionEventSchemas['auction.created'].parse(payload),
      ).toMatchObject({
        auctionId: auction.id,
        shopId: s.shop.id,
        productId: product.id,
        auctionVersion: 1,
        currency: 'EUR',
      });

      const [open] = await t.probe.find('auctions.open', {
        auctionId: auction.id,
      });
      const [close] = await t.probe.find('auctions.close', {
        auctionId: auction.id,
      });
      expect(new Date(open.runAt).toISOString()).toBe(at(0));
      expect(new Date(close.runAt).toISOString()).toBe(at(60 * MIN));
      expect(
        await t.probe.find('auctions.hold-stock', { auctionId: auction.id }),
      ).toHaveLength(1);
    });

    it('S21 AS-01: all of it commits together or not at all (a refused outbox append leaves no row, job or stock change)', async () => {
      const s = await seller();
      t.patch(
        t.app.get(OutboxService),
        'append',
        () => (() => Promise.reject(new Error('outbox refused'))) as never,
      );
      const res = await create(s, s.products[0].id);
      expect(res.status).toBe(500);
      await nothingWritten(s.products[0].id, 3);
    });

    it('S21 AS-01: the shop comes from the path; a shopId in the body is refused', async () => {
      const s = await seller();
      const res = await create(s, s.products[0].id, { shopId: randomUUID() });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      await nothingWritten(s.products[0].id, 3);
    });
  });

  describe('validation classes (AS-02)', () => {
    const invalid: Array<[string, Record<string, unknown>, string]> = [
      ['empty title', { title: '' }, 'title'],
      ['title over 140 characters', { title: 'x'.repeat(141) }, 'title'],
      ['starting price 0', { startingPriceMinor: 0 }, 'startingPriceMinor'],
      [
        'starting price negative',
        { startingPriceMinor: -5 },
        'startingPriceMinor',
      ],
      [
        'starting price fractional',
        { startingPriceMinor: 10.5 },
        'startingPriceMinor',
      ],
      [
        'starting price a string',
        { startingPriceMinor: '1000' },
        'startingPriceMinor',
      ],
      [
        'starting price above the limit',
        { startingPriceMinor: 1_000_000_000_001 },
        'startingPriceMinor',
      ],
      ['increment 0', { minIncrementMinor: 0 }, 'minIncrementMinor'],
      ['reserve 0', { reservePriceMinor: 0 }, 'reservePriceMinor'],
      ['reserve a string', { reservePriceMinor: '3000' }, 'reservePriceMinor'],
      ['startsAt malformed', { startsAt: 'tomorrow' }, 'startsAt'],
      ['endsAt malformed', { endsAt: '2026-13-45' }, 'endsAt'],
      ['unknown property', { buyNowMinor: 5000 }, 'buyNowMinor'],
      ['productId not a UUID', { productId: 'nope' }, 'productId'],
    ];
    it.each(invalid)(
      'S21 AS-02: %s → 400 validation_failed naming the field, nothing changes',
      async (_name, over, field) => {
        const s = await seller();
        const res = await create(s, s.products[0].id, over);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(JSON.stringify(res.body.errors)).toContain(field);
        await nothingWritten(s.products[0].id, 3);
      },
    );

    const unprocessable: Array<[string, Record<string, unknown>, string]> = [
      [
        'reserve below the starting price',
        { reservePriceMinor: 999 },
        'reserve_below_starting',
      ],
      [
        'starts less than a minute ahead',
        { startsAt: at(-5 * MIN + 59_000), endsAt: at(60 * MIN) },
        'starts_too_soon',
      ],
      [
        'shorter than 10 minutes',
        { endsAt: at(10 * MIN - 1000) },
        'duration_out_of_range',
      ],
      [
        'longer than 30 days',
        { endsAt: at(30 * 24 * 60 * MIN + 1000) },
        'duration_out_of_range',
      ],
    ];
    it.each(unprocessable)('S21 AS-02: %s → 422', async (_name, over, code) => {
      const s = await seller();
      const res = await create(s, s.products[0].id, over);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(code);
      await nothingWritten(s.products[0].id, 3);
    });

    it('S21 AS-02: an archived product → 422 product_unavailable', async () => {
      const s = await seller({ status: 'ARCHIVED' });
      const res = await create(s, s.products[0].id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('product_unavailable');
      await nothingWritten(s.products[0].id, 3);
    });

    it('S21 AS-02: stock 0 → 422 insufficient_stock', async () => {
      const s = await seller({ quantity: 0 });
      const res = await create(s, s.products[0].id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('insufficient_stock');
      await nothingWritten(s.products[0].id, 0);
    });

    it('S21 AS-02: a product of another shop → 404 product_not_found (existence hidden)', async () => {
      const s1 = await seller();
      const s2 = await seller();
      const res = await create(s1, s2.products[0].id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('product_not_found');
      await nothingWritten(s2.products[0].id, 3);
    });
  });

  describe('authorization (AS-03)', () => {
    it('S21 AS-03: no credentials → 401 on every route', async () => {
      const s = await seller();
      const a = `/api/shops/${s.shop.id}/auctions`;
      const id = randomUUID();
      for (const res of [
        await t
          .http()
          .post(a)
          .set('Idempotency-Key', 'key-0000-0001')
          .send(body(s.products[0].id)),
        await t.http().get(a),
        await t.http().get(`${a}/${id}`),
        await t.http().post(`${a}/${id}/cancel`),
      ])
        expect(res.status).toBe(401);
      await nothingWritten(s.products[0].id, 3);
    });

    it('S21 AS-03: a member without products.write → 403', async () => {
      const s = await seller();
      const viewer = await t.user();
      await addMember(t.app, s.shop.id, viewer.id, 'VIEWER');
      const res = await t
        .as(viewer)
        .post(`/api/shops/${s.shop.id}/auctions`)
        .set('Idempotency-Key', 'key-0000-0002')
        .send(body(s.products[0].id));
      expect(res.status).toBe(403);
      await nothingWritten(s.products[0].id, 3);
    });

    it('S21 AS-03: a non-member → 404 shop_not_found on create and list', async () => {
      const s = await seller();
      const stranger = await t.user();
      const a = `/api/shops/${s.shop.id}/auctions`;
      const created = await t
        .as(stranger)
        .post(a)
        .set('Idempotency-Key', 'key-0000-0003')
        .send(body(s.products[0].id));
      expect(created.status).toBe(404);
      expect(created.body.code).toBe('shop_not_found');
      expect((await t.as(stranger).get(a)).status).toBe(404);
      await nothingWritten(s.products[0].id, 3);
    });

    it('S21 AS-03: a plan without the auctions feature → 403 entitlement_required {feature}', async () => {
      const s = await seller();
      t.entitlements.granted.delete(s.shop.id);
      const res = await create(s, s.products[0].id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('entitlement_required');
      expect(res.body.feature).toBe('auctions');
      await nothingWritten(s.products[0].id, 3);
    });

    it('S21 AS-03: a suspended shop → 403 shop_suspended', async () => {
      const s = await seller();
      const owner = await t.user();
      const shop = await createShop(t.app, owner, { status: 'SUSPENDED' });
      t.entitlements.granted.add(shop.id);
      const res = await t
        .as(owner)
        .post(`/api/shops/${shop.id}/auctions`)
        .set('Idempotency-Key', 'key-0000-0004')
        .send(body(s.products[0].id));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('shop_suspended');
      await nothingWritten(s.products[0].id, 3);
    });

    it('S21 AS-03: cancel needs products.write; a viewer may read', async () => {
      const s = await seller();
      const id = (await create(s, s.products[0].id)).body.id as string;
      const viewer = await t.user();
      await addMember(t.app, s.shop.id, viewer.id, 'VIEWER');
      const a = `/api/shops/${s.shop.id}/auctions/${id}`;
      expect((await t.as(viewer).post(`${a}/cancel`)).status).toBe(403);
      expect((await t.as(viewer).get(a)).status).toBe(200);
      expect((await auctionRow(id)).status).toBe('SCHEDULED');
    });
  });

  describe('idempotent create (AS-04)', () => {
    it('S21 AS-04: a replay answers the original 201 with Idempotency-Replayed; one auction, the unit held once', async () => {
      const s = await seller();
      const first = await create(s, s.products[0].id, {}, 'create-key-0001');
      const again = await create(s, s.products[0].id, {}, 'create-key-0001');
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(await auctionRows()).toHaveLength(1);
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 2,
      });
    });

    it('S21 AS-04: five identical requests at once → 201 or 409 idempotency_in_flight, one auction, stock lowered once', async () => {
      const s = await seller();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          create(s, s.products[0].id, {}, 'create-key-0002'),
        ),
      );
      for (const r of results) expect([201, 409]).toContain(r.status);
      for (const r of results.filter((x) => x.status === 409))
        expect(r.body.code).toBe('idempotency_in_flight');
      expect(
        results.filter((r) => r.status === 201).length,
      ).toBeGreaterThanOrEqual(1);
      expect(await auctionRows()).toHaveLength(1);
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 2,
      });
    });

    it('S21 AS-04: the key reused with another body → 422 idempotency_key_reuse', async () => {
      const s = await seller();
      await create(s, s.products[0].id, {}, 'create-key-0003');
      const res = await create(
        s,
        s.products[0].id,
        { title: 'Another' },
        'create-key-0003',
      );
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('idempotency_key_reuse');
      expect(await auctionRows()).toHaveLength(1);
    });

    it('S21 AS-04: no key → 422 idempotency_key_required', async () => {
      const s = await seller();
      const res = await t
        .as(s.owner)
        .post(`/api/shops/${s.shop.id}/auctions`)
        .send(body(s.products[0].id));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('idempotency_key_required');
      await nothingWritten(s.products[0].id, 3);
    });

    it.each([
      ['short', 'abc'],
      ['long', 'k'.repeat(129)],
      ['characters', 'key with spaces!'],
    ])('S21 AS-04: a %s key → 422 idempotency_key_invalid', async (_n, key) => {
      const s = await seller();
      const res = await create(s, s.products[0].id, {}, key);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('idempotency_key_invalid');
      await nothingWritten(s.products[0].id, 3);
    });
  });

  describe('one live auction per product (AS-05)', () => {
    it('S21 AS-05: a second create → 409 auction_exists_for_product; after a cancel a new one is accepted', async () => {
      const s = await seller();
      const first = await create(s, s.products[0].id);
      expect(first.status).toBe(201);
      const second = await create(s, s.products[0].id);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('auction_exists_for_product');
      expect(await auctionRows()).toHaveLength(1);
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 2,
      });

      const cancel = await t
        .as(s.owner)
        .post(`/api/shops/${s.shop.id}/auctions/${first.body.id}/cancel`);
      expect(cancel.status).toBe(200);
      const third = await create(s, s.products[0].id);
      expect(third.status).toBe(201);
    });

    it('S21 AS-05: two creates at once (different keys) → one 201, one 409, stock lowered once', async () => {
      const s = await seller();
      const results = await Promise.all([
        create(s, s.products[0].id),
        create(s, s.products[0].id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe(
        'auction_exists_for_product',
      );
      expect(await auctionRows()).toHaveLength(1);
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 2,
      });
    });
  });

  describe('the unit hold is exactly once and gates bidding (AS-06)', () => {
    it('S21 AS-06: a crash between the row and the hold; the sweeper twice lowers the stock once and the auction opens at its start', async () => {
      const s = await seller();
      t.crash.arm('schedule.after_row');
      const crashed = await create(s, s.products[0].id);
      expect(crashed.status).toBe(500);
      expect(t.crash.hits).toContain('schedule.after_row'); // the seam was reached (L-003)

      const [row] = await auctionRows();
      expect(await auctionRow(row.id)).toMatchObject({
        status: 'SCHEDULED',
        unitHeld: false,
      });
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 3,
      });

      await t.setTime(new Date(T.getTime() - 2 * MIN));
      await t.jobs.sweepDue();
      await t.jobs.sweepDue();
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 2,
      });
      expect(await stockOps(row.id)).toHaveLength(1);
      expect(await auctionRow(row.id)).toMatchObject({
        status: 'SCHEDULED',
        unitHeld: true,
      });

      await t.setTime(T);
      await t.jobs.open({ auctionId: row.id });
      expect((await auctionRow(row.id)).status).toBe('OPEN');
    });

    it('S21 AS-06: the open step leaves an auction whose unit is not held SCHEDULED', async () => {
      const s = await seller();
      t.crash.arm('schedule.after_row');
      await create(s, s.products[0].id);
      const [row] = await auctionRows();
      await t.setTime(T);
      await t.jobs.open({ auctionId: row.id });
      expect((await auctionRow(row.id)).status).toBe('SCHEDULED');
      expect(await eventTypes(row.id)).toEqual(['auction.created']);
    });

    it('S21 AS-06: stock gone before the sweeper → CANCELLED(stock_hold_failed), the event, stock unchanged', async () => {
      const s = await seller();
      t.crash.arm('schedule.after_row');
      await create(s, s.products[0].id);
      const [row] = await auctionRows();
      await exec(
        t.app,
        `UPDATE "Product" SET "quantity" = 0 WHERE "id" = :id`,
        { id: s.products[0].id },
      );

      await t.setTime(new Date(T.getTime() - 2 * MIN));
      await t.jobs.sweepDue();
      expect(await auctionRow(row.id)).toMatchObject({
        status: 'CANCELLED',
        statusReason: 'stock_hold_failed',
        unitHeld: false,
        returnPending: false,
      });
      expect(await eventTypes(row.id)).toEqual([
        'auction.created',
        'auction.cancelled',
      ]);
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 0,
      });
      expect(await stockOps(row.id)).toEqual([]);
      expect(
        await t.probe.find('auctions.return-stock', { auctionId: row.id }),
      ).toEqual([]);
    });
  });

  describe('seller read, list and IDOR (AS-07)', () => {
    it('S21 AS-07: newest start first, keyset cursor, filters, bad limits and cursors', async () => {
      const s = await seedSeller(t, [
        { priceMinor: 20_000, quantity: 3 },
        { priceMinor: 20_000, quantity: 3 },
      ]);
      const a = (
        await create(s, s.products[0].id, {
          startsAt: at(0),
          endsAt: at(60 * MIN),
        })
      ).body;
      const b = (
        await create(s, s.products[1].id, {
          startsAt: at(10 * MIN),
          endsAt: at(70 * MIN),
        })
      ).body;
      const list = `/api/shops/${s.shop.id}/auctions`;

      const first = await t.as(s.owner).get(`${list}?limit=1`);
      expect(first.status).toBe(200);
      const page1 = auctionPageSchema.parse(first.body);
      expect(page1.items.map((x) => x.id)).toEqual([b.id]);
      expect(page1.nextCursor).not.toBeNull();
      const second = auctionPageSchema.parse(
        (await t.as(s.owner).get(`${list}?limit=1&cursor=${page1.nextCursor}`))
          .body,
      );
      expect(second.items.map((x) => x.id)).toEqual([a.id]);
      expect(second.nextCursor).toBeNull();

      expect(
        auctionPageSchema.parse(
          (await t.as(s.owner).get(`${list}?status=SCHEDULED`)).body,
        ).items,
      ).toHaveLength(2);
      expect(
        auctionPageSchema.parse(
          (await t.as(s.owner).get(`${list}?status=OPEN`)).body,
        ).items,
      ).toHaveLength(0);

      for (const bad of ['limit=101', 'limit=0', 'limit=abc', 'status=NOPE']) {
        const res = await t.as(s.owner).get(`${list}?${bad}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      }
      const tampered = `${page1.nextCursor!.slice(0, -2)}xx`;
      for (const cursor of [tampered, 'not-a-cursor']) {
        const res = await t.as(s.owner).get(`${list}?cursor=${cursor}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_cursor');
      }
    });

    it("S21 AS-07: another shop's cursor is refused", async () => {
      const s1 = await seller();
      const s2 = await seller();
      await create(s2, s2.products[0].id);
      const own = await seedSeller(t, [
        { priceMinor: 1, quantity: 1 },
        { priceMinor: 1, quantity: 1 },
      ]);
      await create(own, own.products[0].id, { startsAt: at(0) });
      await create(own, own.products[1].id, { startsAt: at(MIN) });
      const page = (
        await t.as(own.owner).get(`/api/shops/${own.shop.id}/auctions?limit=1`)
      ).body;
      const res = await t
        .as(s1.owner)
        .get(`/api/shops/${s1.shop.id}/auctions?cursor=${page.nextCursor}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_cursor');
    });

    it("S21 AS-07: the member view shows the reserve and no bidder identity; another shop's auction is a plain 404", async () => {
      const s1 = await seller();
      const s2 = await seller();
      const mine = (await create(s1, s1.products[0].id)).body;
      const theirs = (await create(s2, s2.products[0].id)).body;

      const read = await t
        .as(s1.owner)
        .get(`/api/shops/${s1.shop.id}/auctions/${mine.id}`);
      expect(read.status).toBe(200);
      expect(auctionMemberSchema.parse(read.body)).toMatchObject({
        reservePriceMinor: 3000,
        bidCount: 0,
        leaderAlias: null,
        winnerOrderId: null,
      });

      const stripped = (res: { body: Record<string, unknown> }) => {
        const { instance: _i, requestId: _r, ...rest } = res.body;
        return rest;
      };
      const unknown = await t
        .as(s1.owner)
        .get(`/api/shops/${s1.shop.id}/auctions/${randomUUID()}`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('auction_not_found');
      for (const url of [
        `/api/shops/${s1.shop.id}/auctions/${theirs.id}`,
        `/api/shops/${s2.shop.id}/auctions/${theirs.id}`,
      ]) {
        const res = await t.as(s1.owner).get(url);
        expect(res.status).toBe(404);
        expect(stripped(res)).toEqual(stripped(unknown));
      }
      const cancel = await t
        .as(s1.owner)
        .post(`/api/shops/${s1.shop.id}/auctions/${theirs.id}/cancel`);
      expect(cancel.status).toBe(404);
      expect(cancel.body.code).toBe('auction_not_found');
      expect((await auctionRow(theirs.id)).status).toBe('SCHEDULED');
    });
  });

  describe('cancel and its guards (AS-08)', () => {
    const cancel = (s: Seller, id: string) =>
      t.as(s.owner).post(`/api/shops/${s.shop.id}/auctions/${id}/cancel`);

    it('S21 AS-08: a scheduled auction is cancelled, the unit goes back once, a repeat is 200 and changes nothing, the later close job is a no-op', async () => {
      const s = await seller();
      const id = (await create(s, s.products[0].id)).body.id as string;
      const res = await cancel(s, id);
      expect(res.status).toBe(200);
      expect(auctionMemberSchema.parse(res.body)).toMatchObject({
        status: 'CANCELLED',
        statusReason: 'seller_cancelled',
      });
      expect(await historyOf(id)).toEqual([
        {
          fromStatus: null,
          toStatus: 'SCHEDULED',
          reason: null,
          auctionVersion: 1,
        },
        {
          fromStatus: 'SCHEDULED',
          toStatus: 'CANCELLED',
          reason: 'seller_cancelled',
          auctionVersion: 2,
        },
      ]);
      expect(await eventTypes(id)).toEqual([
        'auction.created',
        'auction.cancelled',
      ]);
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 3,
      });
      expect((await stockOps(id)).map((o) => o.operationId)).toEqual([
        `auctions:${id}:hold`,
        `auctions:${id}:return`,
      ]);

      const again = await cancel(s, id);
      expect(again.status).toBe(200);
      expect(again.body).toEqual(res.body);
      await t.jobs.returnStock({ auctionId: id });
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 3,
      });
      expect(await historyOf(id)).toHaveLength(2);
      // the later close job finding a terminal auction is proven with the close handler (auction-close.e2e-spec.ts)
    });

    it('S21 AS-08: an open auction with no bids is cancelled the same way', async () => {
      const s = await seller();
      const id = await openAuction(s);
      const res = await cancel(s, id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 3,
      });
    });

    it('S21 AS-08: with a bid → 409 auction_has_bids, nothing changes', async () => {
      const s = await seller();
      const id = await openAuction(s);
      await exec(
        t.app,
        `UPDATE "Auction" SET "bidCount" = 1, "version" = "version" + 1 WHERE "id" = :id`,
        { id },
      );
      const before = await auctionRow(id);
      const res = await cancel(s, id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('auction_has_bids');
      expect(await auctionRow(id)).toEqual(before);
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 2,
      });
    });

    it.each(['CLOSED', 'SECOND_CHANCE', 'SOLD', 'UNSOLD'])(
      'S21 AS-08: a %s auction → 409 auction_not_cancellable, nothing changes',
      async (status) => {
        const s = await seller();
        const id = (await create(s, s.products[0].id)).body.id as string;
        await exec(
          t.app,
          `UPDATE "Auction" SET "status" = :status WHERE "id" = :id`,
          { id, status },
        );
        const res = await cancel(s, id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('auction_not_cancellable');
        expect((await auctionRow(id)).status).toBe(status);
        expect(await stockOf(t.app, [s.products[0].id])).toEqual({
          [s.products[0].id]: 2,
        });
      },
    );
  });

  describe('cancel races the first bid (AS-09)', () => {
    it('S21 AS-09: exactly one wins, never a cancelled auction with a bid, the unit returns iff cancelled (10 rounds)', async () => {
      // each product has 2 in stock: the auction already holds its third unit
      const s = await seedSeller(
        t,
        Array.from({ length: 10 }, () => ({ priceMinor: 20_000, quantity: 2 })),
      );
      const bidder = await t.user();
      await t.setTime(T);
      const outcomes = new Set<string>();
      for (const product of s.products) {
        const id = await seedAuction(t.app, {
          shopId: s.shop.id,
          productId: product.id,
          startsAt: T,
          endsAt: new Date(at(60 * MIN)),
        });
        const [cancelled, bid] = await Promise.all([
          t.as(s.owner).post(`/api/shops/${s.shop.id}/auctions/${id}/cancel`),
          t
            .as(bidder)
            .post(`/api/auctions/${id}/bids`)
            .set('Idempotency-Key', `race-${randomUUID()}`)
            .send({ maxAmountMinor: 5000 }),
        ]);
        const row = await auctionRow(id);
        const bids = await rows(
          t.app,
          `SELECT 1 FROM "Bid" WHERE "auctionId" = :id`,
          { id },
        );
        const stock = (await stockOf(t.app, [product.id]))[product.id];
        if (cancelled.status === 200) {
          outcomes.add('cancel');
          expect(bid.status).toBe(409);
          expect(bid.body.code).toBe('auction_closed');
          expect(row.status).toBe('CANCELLED');
          expect(bids).toHaveLength(0);
          expect(stock).toBe(3);
        } else {
          outcomes.add('bid');
          expect(cancelled.status).toBe(409);
          expect(cancelled.body.code).toBe('auction_has_bids');
          expect(bid.status).toBe(200);
          expect(row.status).toBe('OPEN');
          expect(bids).toHaveLength(1);
          expect(stock).toBe(2);
        }
        await exec(
          t.app,
          `UPDATE "Auction" SET "status" = 'UNSOLD' WHERE "id" = :id`,
          { id },
        );
      }
      expect(outcomes.size).toBeGreaterThanOrEqual(1);
    }, 120_000);
  });

  describe('job payloads (AS-35: open)', () => {
    it('S21 AS-35: auctions.open delivered twice opens once: one history row, one auction.opened', async () => {
      const s = await seller();
      const id = (await create(s, s.products[0].id)).body.id as string;
      await t.setTime(T);
      await Promise.all([
        t.jobs.open({ auctionId: id }),
        t.jobs.open({ auctionId: id }),
      ]);
      await t.jobs.open({ auctionId: id });
      expect((await auctionRow(id)).status).toBe('OPEN');
      expect((await historyOf(id)).map((h) => h.toStatus)).toEqual([
        'SCHEDULED',
        'OPEN',
      ]);
      expect(await eventTypes(id)).toEqual([
        'auction.created',
        'auction.opened',
      ]);
    });

    it('S21 AS-35: a malformed payload or an unknown auction is rejected with no side effect', async () => {
      const before = await rows(t.app, `SELECT 1 FROM "Outbox"`);
      for (const payload of [
        {},
        { auctionId: 'nope' },
        { auctionId: randomUUID() },
      ])
        await expect(t.jobs.open(payload as never)).rejects.toThrow();
      expect(await rows(t.app, `SELECT 1 FROM "Outbox"`)).toEqual(before);
      expect(await auctionRows()).toEqual([]);
    });
  });
});
