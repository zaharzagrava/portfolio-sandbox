import { randomUUID } from 'node:crypto';
import {
  OrderCommandRejectedError,
  OrderCommandService,
} from '@app/domains/orders';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import type { TestUser } from '@app/test/utils/catalog-app';
import { addMember } from '@app/test/utils/tenancy-fixtures';
import {
  AUCTION_REPOSITORY,
  type AuctionRepository,
} from './domain/auction-ports';
import {
  createAuctionsApp,
  exec,
  fastStoreOf,
  orderCancelledEnvelope,
  orderPaidEnvelope,
  rows,
  seedAuction,
  seedSeller,
  stockOf,
  type AuctionTestApp,
  type FastStore,
  type Seller,
} from './testing/auction-app';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T = new Date('2026-10-14T12:00:00.000Z');
const E = new Date(T.getTime() + 60 * MIN);

describe('Auctions: exactly-once close, winner order and second chance', () => {
  let t: AuctionTestApp;
  let fast: FastStore;

  beforeAll(async () => {
    t = await createAuctionsApp();
    fast = fastStoreOf(t.app);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await fast.clearRateLimits();
    await t.setTime(T);
  });

  // ------------------------------------------------------------------ helpers

  const bid = (user: TestUser, id: string, max: number) =>
    t
      .as(user)
      .post(`/api/auctions/${id}/bids`)
      .set('Idempotency-Key', `bid-${randomUUID()}`)
      .send({ maxAmountMinor: max });
  const bidders = async (n: number) => {
    const out: TestUser[] = [];
    // 25 at a time: the users are separate rows and sessions
    for (let i = 0; i < n; i += 25)
      out.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(25, n - i) }, () => t.user()),
        )),
      );
    return out;
  };
  type Row = {
    status: string;
    statusReason: string | null;
    winnerId: string | null;
    finalPriceMinor: string | null;
    closedAt: Date | null;
    winnerOrderId: string | null;
    firstOrderId: string | null;
    offerExpiresAt: Date | null;
    returnPending: boolean;
    unitHeld: boolean;
    version: number;
    bidCount: number;
    settlementOrderVersion: number;
  };
  const auction = async (id: string) =>
    (
      await rows<Row>(
        t.app,
        `SELECT "status","statusReason","winnerId","finalPriceMinor","closedAt","winnerOrderId","firstOrderId","offerExpiresAt","returnPending","unitHeld","version","bidCount","settlementOrderVersion" FROM "Auction" WHERE "id" = :id`,
        { id },
      )
    )[0];
  const history = (id: string) =>
    rows<{
      fromStatus: string | null;
      toStatus: string;
      reason: string | null;
    }>(
      t.app,
      `SELECT "fromStatus","toStatus","reason" FROM "AuctionHistory" WHERE "auctionId" = :id ORDER BY "auctionVersion","at"`,
      { id },
    );
  const events = (id: string) => outboxRowsFor(t.app, id);
  const eventTypes = async (id: string) =>
    (await events(id)).map((e) => e.type);
  const payload = (row: { payload: Record<string, unknown> }) =>
    (row.payload as { payload: Record<string, unknown> }).payload;
  const eventOf = async (id: string, type: string) =>
    payload((await events(id)).filter((e) => e.type === type).pop()!);
  const ordersOf = (userId: string) =>
    rows<{
      id: string;
      status: string;
      total: string;
      currency: string;
      reservedUntil: Date;
    }>(
      t.app,
      `SELECT "id","status","total","currency","reservedUntil" FROM "BisOrder" WHERE "userId" = :userId ORDER BY "createdAt"`,
      { userId },
    );
  const jobsOf = (type: Parameters<typeof t.probe.find>[0], id: string) =>
    t.probe.find(type, { auctionId: id });
  const stockOps = (id: string) =>
    rows<{ operationId: string }>(
      t.app,
      `SELECT "operationId" FROM "ProductStockOperation" WHERE "operationId" LIKE :like ORDER BY "operationId"`,
      { like: `auctions:${id}:%` },
    );

  interface Awarded {
    s: Seller;
    id: string;
    users: TestUser[];
  }

  /** An auction that ran to its end: `bids` are `[bidder index, maximum]` pairs placed at `T`, the close ran at `E`. */
  const closedAuction = async (
    bids: Array<[number, number]>,
    options: { reserve?: number; bidders?: number } = {},
  ): Promise<Awarded> => {
    // the product has 2 in stock: the auction already holds its third unit
    const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 2 }]);
    const users = await bidders(options.bidders ?? 3);
    const id = await seedAuction(t.app, {
      shopId: s.shop.id,
      productId: s.products[0].id,
      startsAt: T,
      endsAt: E,
      originalEndsAt: T, // the extension cap is reached: late bids cannot move the end
      reservePriceMinor: options.reserve ?? null,
    });
    for (const [who, max] of bids) {
      const res = await bid(users[who], id, max);
      expect(res.status).toBe(200);
    }
    await t.setTime(E);
    await t.jobs.close({ auctionId: id });
    return { s, id, users };
  };
  const requestOrder = (
    id: string,
    step: 'winner' | 'second-chance' = 'winner',
  ) => t.jobs.requestOrder({ auctionId: id, step }, { isLastAttempt: false });
  const deliver = (...envelopes: Parameters<typeof t.consumer.project>[0]) =>
    t.consumer.project(envelopes);

  // ------------------------------------------------------------------ AS-27 – AS-30

  describe('close with a winner (AS-27)', () => {
    it('S21 AS-27: CLOSED with the winner, history, event, push and the request job; the order is RESERVED at the final price with no stock movement', async () => {
      const { s, id, users } = await closedAuction([[0, 4000]], {
        reserve: 3000,
        bidders: 1,
      });
      const [u1] = users;

      expect(await auction(id)).toMatchObject({
        status: 'CLOSED',
        statusReason: null,
        winnerId: u1.id,
        finalPriceMinor: '3000',
        winnerOrderId: null,
        returnPending: false,
      });
      expect((await auction(id)).closedAt!.toISOString()).toBe(E.toISOString());
      expect(await history(id)).toEqual([
        { fromStatus: 'OPEN', toStatus: 'CLOSED', reason: null },
      ]);
      expect(await eventOf(id, 'auction.closed')).toMatchObject({
        status: 'CLOSED',
        winnerId: u1.id,
        finalPriceMinor: 3000,
        currency: 'EUR',
        reserveMet: true,
        reason: 'winner',
      });
      const pushes = t.realtime.published.filter((m) => m.type === 'closed');
      expect(pushes).toHaveLength(1);
      expect(pushes[0].data).toEqual({
        auctionId: id,
        status: 'CLOSED',
        finalPriceMinor: 3000,
        version: (await auction(id)).version,
      });
      expect(JSON.stringify(pushes)).not.toContain(u1.id);
      expect(await jobsOf('auctions.request-order', id)).toHaveLength(1);
      expect(await ordersOf(u1.id)).toEqual([]);

      await requestOrder(id);
      const [order] = await ordersOf(u1.id);
      expect(order).toMatchObject({
        status: 'RESERVED',
        total: '3000',
        currency: 'EUR',
      });
      expect(order.reservedUntil.toISOString()).toBe(
        new Date(E.getTime() + 48 * HOUR).toISOString(),
      );
      const row = await auction(id);
      expect(row.winnerOrderId).toBe(order.id);
      expect(row.firstOrderId).toBe(order.id);
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 2,
      });
      expect(await stockOps(id)).toEqual([]);
      const reservations = await rows<{ source: string; status: string }>(
        t.app,
        `SELECT "source","status" FROM "StockReservation" WHERE "bisOrderId" = :id`,
        { id: order.id },
      );
      expect(reservations).toEqual([{ source: 'EXTERNAL', status: 'HELD' }]);
    });
  });

  describe('exactly-once close (AS-28)', () => {
    it('S21 AS-28: three deliveries at once, then again: one transition, one history row, one event, one request, one message', async () => {
      const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 2 }]);
      const [u1] = await bidders(1);
      const id = await seedAuction(t.app, {
        shopId: s.shop.id,
        productId: s.products[0].id,
        startsAt: T,
        endsAt: E,
        originalEndsAt: T,
      });
      await bid(u1, id, 5000);
      const before = (await auction(id)).version;
      await t.setTime(E);

      await Promise.all([1, 2, 3].map(() => t.jobs.close({ auctionId: id })));
      await t.jobs.close({ auctionId: id });
      await t.jobs.close({ auctionId: id });

      expect((await auction(id)).status).toBe('CLOSED');
      expect((await auction(id)).version).toBe(before + 1);
      expect(await history(id)).toHaveLength(1);
      expect(
        (await eventTypes(id)).filter((x) => x === 'auction.closed'),
      ).toHaveLength(1);
      expect(await jobsOf('auctions.request-order', id)).toHaveLength(1);
      expect(
        t.realtime.published.filter((m) => m.type === 'closed'),
      ).toHaveLength(1);
    });
  });

  describe('reserve not met and no bids (AS-29, AS-30)', () => {
    it('S21 AS-29: UNSOLD(reserve_not_met), no order, the unit returned once', async () => {
      const { s, id } = await closedAuction(
        [
          [0, 2500],
          [1, 2900],
        ],
        { reserve: 3000, bidders: 2 },
      );
      expect(await auction(id)).toMatchObject({
        status: 'UNSOLD',
        statusReason: 'reserve_not_met',
        winnerId: null,
        finalPriceMinor: null,
        returnPending: true,
      });
      expect(await eventOf(id, 'auction.closed')).toMatchObject({
        status: 'UNSOLD',
        winnerId: null,
        finalPriceMinor: null,
        reserveMet: false,
        reason: 'reserve_not_met',
      });
      expect(await jobsOf('auctions.request-order', id)).toEqual([]);

      await t.jobs.returnStock({ auctionId: id });
      await t.jobs.returnStock({ auctionId: id });
      await t.jobs.close({ auctionId: id });
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 3,
      });
      expect(await stockOps(id)).toEqual([
        { operationId: `auctions:${id}:return` },
      ]);
      expect(await jobsOf('auctions.return-stock', id)).toHaveLength(1);
    });

    it('S21 AS-30: no bids → UNSOLD(no_bids), reserveMet false, the unit returned once, no order', async () => {
      const { s, id } = await closedAuction([], { bidders: 0 });
      expect(await auction(id)).toMatchObject({
        status: 'UNSOLD',
        statusReason: 'no_bids',
      });
      expect(await eventOf(id, 'auction.closed')).toMatchObject({
        status: 'UNSOLD',
        reason: 'no_bids',
        reserveMet: false,
        winnerId: null,
      });
      await t.jobs.returnStock({ auctionId: id });
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 3,
      });
      expect(await jobsOf('auctions.request-order', id)).toEqual([]);
    });

    it('S21 AS-08: the close job finding a cancelled auction does nothing', async () => {
      const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 3 }]);
      const id = await seedAuction(t.app, {
        shopId: s.shop.id,
        productId: s.products[0].id,
        startsAt: T,
        endsAt: E,
        status: 'CANCELLED',
      });
      await t.setTime(E);
      await t.jobs.close({ auctionId: id });
      expect((await auction(id)).status).toBe('CANCELLED');
      expect(await eventTypes(id)).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ AS-31, AS-32

  describe('a lost close job is recovered (AS-31)', () => {
    it('S21 AS-31: the sweeper closes a due auction within a sweep, twice at once and then the late job change nothing further; a not-yet-due auction is left', async () => {
      const s = await seedSeller(t, [
        { priceMinor: 20_000, quantity: 2 },
        { priceMinor: 20_000, quantity: 2 },
      ]);
      const [u1] = await bidders(1);
      const due = await seedAuction(t.app, {
        shopId: s.shop.id,
        productId: s.products[0].id,
        startsAt: T,
        endsAt: E,
        originalEndsAt: T,
      });
      const later = await seedAuction(t.app, {
        shopId: s.shop.id,
        productId: s.products[1].id,
        startsAt: T,
        endsAt: new Date(E.getTime() + 30 * MIN),
        originalEndsAt: T,
      });
      await bid(u1, due, 5000);
      // no close job exists for either (they were lost); the clock reaches 10 s past the first end
      await t.setTime(new Date(E.getTime() + 10_000));
      await Promise.all([t.jobs.sweepDue(), t.jobs.sweepDue()]);

      expect((await auction(due)).status).toBe('CLOSED');
      expect((await auction(later)).status).toBe('OPEN');
      expect(
        (await eventTypes(due)).filter((x) => x === 'auction.closed'),
      ).toHaveLength(1);
      const version = (await auction(due)).version;
      await t.jobs.close({ auctionId: due });
      await t.jobs.sweepDue();
      expect((await auction(due)).version).toBe(version);
      expect(await jobsOf('auctions.request-order', due)).toHaveLength(1);
      const lag = MetricsRegistry.histogramValue('auction_close_lag_seconds');
      expect(lag?.count ?? 0).toBeGreaterThan(0);
    });
  });

  describe('a bid races the close (AS-32)', () => {
    /** Waits until a statement is waiting for a row lock (the close behind the held bid), never sleeping blindly. */
    const untilBlockedOnLock = async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = await rows(
          t.app,
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active'`,
        );
        if (waiting.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('the close never reached the lock');
    };

    it('S21 AS-32: a bid held inside its decision at E − 1 ms; the close at E waits for it and closes with the raised state', async () => {
      const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 2 }]);
      const [u1] = await bidders(1);
      const id = await seedAuction(t.app, {
        shopId: s.shop.id,
        productId: s.products[0].id,
        startsAt: T,
        endsAt: E,
        originalEndsAt: T,
      });
      await bid(u1, id, 5000);

      await t.setTime(new Date(E.getTime() - 1));
      const gate = t.gate.arm(u1.id);
      const raising = Promise.resolve(bid(u1, id, 7000));
      await gate.reached; // the seam was reached (L-003)
      await t.setTime(E);
      const closing = t.jobs.close({ auctionId: id });
      await untilBlockedOnLock();
      gate.open();
      const [raised] = await Promise.all([raising, closing]);

      expect(raised.status).toBe(200);
      expect(raised.body.outcome).toBe('raised');
      const row = await auction(id);
      expect(row).toMatchObject({
        status: 'CLOSED',
        winnerId: u1.id,
        bidCount: 2,
      });
      // no 200 is returned for a bid whose effect is missing from the closed result
      const log = await rows<{ maxAmountMinor: string }>(
        t.app,
        `SELECT "maxAmountMinor" FROM "Bid" WHERE "auctionId" = :id ORDER BY "sequence"`,
        { id },
      );
      expect(log.map((r) => r.maxAmountMinor)).toEqual(['5000', '7000']);
    });

    it('S21 AS-32: a bid at or after endsAt is 409 auction_closed, before and after the close committed; nothing is recorded', async () => {
      const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 2 }]);
      const [u1, u2] = await bidders(2);
      const id = await seedAuction(t.app, {
        shopId: s.shop.id,
        productId: s.products[0].id,
        startsAt: T,
        endsAt: E,
        originalEndsAt: T,
      });
      await bid(u1, id, 5000);
      await t.setTime(E);
      const beforeClose = await bid(u2, id, 9000);
      expect(beforeClose.status).toBe(409);
      expect(beforeClose.body.code).toBe('auction_closed');
      await t.jobs.close({ auctionId: id });
      const afterClose = await bid(u2, id, 9000);
      expect(afterClose.status).toBe(409);
      expect(afterClose.body.auctionStatus).toBe('CLOSED');
      expect((await auction(id)).bidCount).toBe(1);
    });
  });

  // ------------------------------------------------------------------ AS-33

  describe('the winner order request survives crashes and failures (AS-33)', () => {
    it('S21 AS-33: a crash before the request; the retry, delivered twice at once, leaves one order and one stored ID', async () => {
      const { id, users } = await closedAuction([[0, 4000]], { bidders: 1 });
      t.crash.arm('settlement.before_request');
      await expect(requestOrder(id)).rejects.toThrow(
        /crash at settlement.before_request/,
      );
      expect(t.crash.hits).toContain('settlement.before_request'); // the seam was reached (L-003)
      expect(await ordersOf(users[0].id)).toEqual([]);
      expect((await auction(id)).winnerOrderId).toBeNull();

      await Promise.all([requestOrder(id), requestOrder(id)]);
      await requestOrder(id);
      const orders = await ordersOf(users[0].id);
      expect(orders).toHaveLength(1);
      expect((await auction(id)).winnerOrderId).toBe(orders[0].id);
    });

    it('S21 AS-33: a transient failure of orders fails the attempt (counted, then dead-lettered on the last) and leaves the auction CLOSED', async () => {
      const { id } = await closedAuction([[0, 4000]], { bidders: 1 });
      expect(getJobTypeDeclaration('auctions.request-order')?.maxAttempts).toBe(
        8,
      );
      t.patch(
        t.app.get(OrderCommandService, { strict: false }),
        'createFixedPriceOrder',
        () => (() => Promise.reject(new Error('orders timeout'))) as never,
      );
      const transient = () =>
        MetricsRegistry.value('auction_order_request_failed_total', {
          kind: 'transient',
        }) ?? 0;
      const dead = () =>
        MetricsRegistry.value('auction_order_request_failed_total', {
          kind: 'dead_letter',
        }) ?? 0;
      const [t0, d0] = [transient(), dead()];

      await expect(
        t.jobs.requestOrder(
          { auctionId: id, step: 'winner' },
          { isLastAttempt: false },
        ),
      ).rejects.toThrow('orders timeout');
      await expect(
        t.jobs.requestOrder(
          { auctionId: id, step: 'winner' },
          { isLastAttempt: true },
        ),
      ).rejects.toThrow('orders timeout');
      expect(transient()).toBe(t0 + 1);
      expect(dead()).toBe(d0 + 1);
      expect((await auction(id)).status).toBe('CLOSED');
      expect((await auction(id)).winnerOrderId).toBeNull();
    });

    it('S21 AS-33: a permanent rejection is handled as an unpaid winner (no runner-up → UNSOLD(winner_unpaid), the unit returned)', async () => {
      const { s, id } = await closedAuction([[0, 4000]], { bidders: 1 });
      t.patch(
        t.app.get(OrderCommandService, { strict: false }),
        'createFixedPriceOrder',
        () =>
          (() =>
            Promise.reject(
              new OrderCommandRejectedError('buyer_not_eligible'),
            )) as never,
      );
      await requestOrder(id);
      expect(await auction(id)).toMatchObject({
        status: 'UNSOLD',
        statusReason: 'winner_unpaid',
      });
      expect(await eventOf(id, 'auction.unsold')).toMatchObject({
        reason: 'winner_unpaid',
      });
      await t.jobs.returnStock({ auctionId: id });
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 3,
      });
    });

    it('S21 AS-33: the sweeper asks again for an awarded auction whose order was never recorded', async () => {
      const { id, users } = await closedAuction([[0, 4000]], { bidders: 1 });
      await t.setTime(new Date(E.getTime() + 2 * MIN));
      await t.jobs.sweepDue();
      expect(await ordersOf(users[0].id)).toHaveLength(1);
      expect((await auction(id)).winnerOrderId).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------ AS-34, AS-35

  describe('the winner pays (AS-34)', () => {
    it('S21 AS-34: order.paid sells the auction once; a duplicate changes nothing', async () => {
      const { id, users } = await closedAuction([[0, 4000]], {
        reserve: 3000,
        bidders: 1,
      });
      await requestOrder(id);
      const orderId = (await auction(id)).winnerOrderId!;

      await deliver(
        orderPaidEnvelope({
          orderId,
          userId: users[0].id,
          totalMinor: 3000,
          orderVersion: 3,
        }),
      );
      expect((await auction(id)).status).toBe('SOLD');
      expect(await history(id)).toEqual([
        { fromStatus: 'OPEN', toStatus: 'CLOSED', reason: null },
        { fromStatus: 'CLOSED', toStatus: 'SOLD', reason: null },
      ]);
      expect(await eventOf(id, 'auction.sold')).toMatchObject({
        buyerId: users[0].id,
        finalPriceMinor: 3000,
        currency: 'EUR',
        orderId,
        viaSecondChance: false,
      });

      const version = (await auction(id)).version;
      await deliver(
        orderPaidEnvelope({
          orderId,
          userId: users[0].id,
          totalMinor: 3000,
          orderVersion: 3,
        }),
      );
      expect((await auction(id)).version).toBe(version);
      expect(
        (await eventTypes(id)).filter((x) => x === 'auction.sold'),
      ).toHaveLength(1);
      expect(await jobsOf('auctions.return-stock', id)).toEqual([]);
    });

    it('S21 AS-34: an invalid payload is dead-lettered with no state change; an order that is not ours is ignored', async () => {
      const { id, users } = await closedAuction([[0, 4000]], { bidders: 1 });
      await requestOrder(id);
      const orderId = (await auction(id)).winnerOrderId!;
      const valid = orderPaidEnvelope({
        orderId,
        userId: users[0].id,
        totalMinor: 4000,
        orderVersion: 3,
      });
      const broken = {
        ...valid,
        payload: { ...(valid.payload as object), orderId: undefined },
      };
      await expect(deliver(broken as never)).rejects.toThrow(
        /invalid order.paid payload/,
      );
      const wrongTypes = {
        ...valid,
        payload: { ...(valid.payload as object), totalMinor: 'a lot' },
      };
      await expect(deliver(wrongTypes as never)).rejects.toThrow();
      expect((await auction(id)).status).toBe('CLOSED');

      const before = (await auction(id)).version;
      await deliver(
        orderPaidEnvelope({
          orderId: randomUUID(),
          userId: randomUUID(),
          totalMinor: 1,
          orderVersion: 2,
        }),
      );
      await deliver(
        orderCancelledEnvelope({
          orderId: randomUUID(),
          userId: randomUUID(),
          orderVersion: 2,
        }),
      );
      expect((await auction(id)).version).toBe(before);
    });
  });

  describe('job payloads (AS-35: close and order request)', () => {
    it('S21 AS-35: an unknown auction or a malformed payload is rejected with no state change and nothing published', async () => {
      const { id } = await closedAuction([[0, 4000]], { bidders: 1 });
      const snapshot = async () => ({
        auction: await auction(id),
        events: (await events(id)).length,
        all: (await rows(t.app, `SELECT 1 FROM "Outbox"`)).length,
        pushes: t.realtime.published.length,
      });
      const before = await snapshot();
      for (const call of [
        () => t.jobs.close({} as never),
        () => t.jobs.close({ auctionId: 'nope' } as never),
        () => t.jobs.close({ auctionId: randomUUID() }),
        () => t.jobs.requestOrder({ auctionId: id } as never),
        () => t.jobs.requestOrder({ auctionId: id, step: 'third' } as never),
        () => t.jobs.requestOrder({ auctionId: randomUUID(), step: 'winner' }),
      ])
        await expect(call()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    });
  });

  // ------------------------------------------------------------------ AS-36 – AS-39

  describe('second chance (AS-36 – AS-39)', () => {
    /** U1 10000, U2 5000, U3 3000 (price 5500, leader U1), closed, U1's order `O1` reserved. */
    const withFirstOrder = async (reserve?: number) => {
      // placed in this order the price ends at 5500 with U1 leading (a bid must beat price + increment)
      const awarded = await closedAuction(
        [
          [2, 3000],
          [1, 5000],
          [0, 10_000],
        ],
        { reserve },
      );
      await requestOrder(awarded.id);
      const first = (await auction(awarded.id)).winnerOrderId!;
      return { ...awarded, first };
    };

    it.each(['hold_expired', 'user_cancelled', 'payment_failed'] as const)(
      'S21 AS-36: order.cancelled (%s) offers the unit once to the runner-up at their own maximum for 24 h',
      async (reason) => {
        const { s, id, users, first } = await withFirstOrder();
        await deliver(
          orderCancelledEnvelope({
            orderId: first,
            userId: users[0].id,
            orderVersion: 3,
            reason,
          }),
        );

        const row = await auction(id);
        expect(row).toMatchObject({
          status: 'SECOND_CHANCE',
          winnerId: users[1].id,
          finalPriceMinor: '5000',
          winnerOrderId: null,
          firstOrderId: first,
          returnPending: false,
        });
        expect(row.offerExpiresAt!.toISOString()).toBe(
          new Date(E.getTime() + 24 * HOUR).toISOString(),
        );
        expect((await history(id)).pop()).toEqual({
          fromStatus: 'CLOSED',
          toStatus: 'SECOND_CHANCE',
          reason: null,
        });
        expect(
          await eventOf(id, 'auction.second_chance_offered'),
        ).toMatchObject({
          offeredToId: users[1].id,
          priceMinor: 5000,
          currency: 'EUR',
          expiresAt: row.offerExpiresAt!.toISOString(),
        });
        const [secondJob] = await t.probe.find('auctions.request-order', {
          auctionId: id,
          step: 'second-chance',
        });
        expect(secondJob).toBeDefined();

        await requestOrder(id, 'second-chance');
        const [offer] = await ordersOf(users[1].id);
        expect(offer).toMatchObject({ status: 'RESERVED', total: '5000' });
        expect(offer.reservedUntil.toISOString()).toBe(
          row.offerExpiresAt!.toISOString(),
        );
        expect((await auction(id)).winnerOrderId).toBe(offer.id);
        expect((await auction(id)).firstOrderId).toBe(first);
        expect(await jobsOf('auctions.return-stock', id)).toEqual([]); // the unit stays held
        expect(await stockOf(t.app, [s.products[0].id])).toEqual({
          [s.products[0].id]: 2,
        });
      },
    );

    it('S21 AS-37: the offer paid → SOLD via second chance; the offer cancelled → UNSOLD(second_chance_unpaid), the unit returned once, no third offer', async () => {
      const paid = await withFirstOrder();
      await deliver(
        orderCancelledEnvelope({
          orderId: paid.first,
          userId: paid.users[0].id,
          orderVersion: 3,
        }),
      );
      await requestOrder(paid.id, 'second-chance');
      const o2 = (await auction(paid.id)).winnerOrderId!;
      await deliver(
        orderPaidEnvelope({
          orderId: o2,
          userId: paid.users[1].id,
          totalMinor: 5000,
          orderVersion: 2,
        }),
      );
      expect((await auction(paid.id)).status).toBe('SOLD');
      expect(await eventOf(paid.id, 'auction.sold')).toMatchObject({
        buyerId: paid.users[1].id,
        finalPriceMinor: 5000,
        orderId: o2,
        viaSecondChance: true,
      });

      await t.reset();
      await t.setTime(T);
      const lapsed = await withFirstOrder();
      await deliver(
        orderCancelledEnvelope({
          orderId: lapsed.first,
          userId: lapsed.users[0].id,
          orderVersion: 3,
        }),
      );
      await requestOrder(lapsed.id, 'second-chance');
      const offer = (await auction(lapsed.id)).winnerOrderId!;
      await deliver(
        orderCancelledEnvelope({
          orderId: offer,
          userId: lapsed.users[1].id,
          orderVersion: 2,
        }),
      );
      expect(await auction(lapsed.id)).toMatchObject({
        status: 'UNSOLD',
        statusReason: 'second_chance_unpaid',
      });
      expect(await eventOf(lapsed.id, 'auction.unsold')).toMatchObject({
        reason: 'second_chance_unpaid',
      });
      await t.jobs.returnStock({ auctionId: lapsed.id });
      await t.jobs.returnStock({ auctionId: lapsed.id });
      expect(await stockOf(t.app, [lapsed.s.products[0].id])).toEqual({
        [lapsed.s.products[0].id]: 3,
      });
      // an auction offers at most once: a winner request and one second-chance request, nothing more
      expect(await jobsOf('auctions.request-order', lapsed.id)).toHaveLength(2);
      await deliver(
        orderCancelledEnvelope({
          orderId: lapsed.first,
          userId: lapsed.users[0].id,
          orderVersion: 9,
        }),
      );
      expect(await jobsOf('auctions.request-order', lapsed.id)).toHaveLength(2);
    });

    it('S21 AS-38: no eligible runner-up (below the reserve, nobody else, a shop member) → UNSOLD(winner_unpaid), no command, the unit returned once', async () => {
      // the only other bidder's maximum is below the reserve
      const belowReserve = await closedAuction(
        [
          [1, 2000],
          [0, 4000],
        ],
        { reserve: 3000, bidders: 2 },
      );
      await requestOrder(belowReserve.id);
      const o1 = (await auction(belowReserve.id)).winnerOrderId!;
      await deliver(
        orderCancelledEnvelope({
          orderId: o1,
          userId: belowReserve.users[0].id,
          orderVersion: 3,
        }),
      );
      expect(await auction(belowReserve.id)).toMatchObject({
        status: 'UNSOLD',
        statusReason: 'winner_unpaid',
      });
      expect(await eventOf(belowReserve.id, 'auction.unsold')).toMatchObject({
        reason: 'winner_unpaid',
      });
      expect(
        await t.probe.find('auctions.request-order', {
          auctionId: belowReserve.id,
          step: 'second-chance',
        }),
      ).toEqual([]);
      await t.jobs.returnStock({ auctionId: belowReserve.id });
      expect(await stockOf(t.app, [belowReserve.s.products[0].id])).toEqual({
        [belowReserve.s.products[0].id]: 3,
      });

      // nobody else bid
      await t.reset();
      await t.setTime(T);
      const alone = await closedAuction([[0, 4000]], { bidders: 1 });
      await requestOrder(alone.id);
      await deliver(
        orderCancelledEnvelope({
          orderId: (await auction(alone.id)).winnerOrderId!,
          userId: alone.users[0].id,
          orderVersion: 3,
        }),
      );
      expect(await auction(alone.id)).toMatchObject({
        status: 'UNSOLD',
        statusReason: 'winner_unpaid',
      });

      // the only runner-up became a member of the selling shop
      await t.reset();
      await t.setTime(T);
      const shill = await closedAuction(
        [
          [1, 2000],
          [0, 4000],
        ],
        { bidders: 2 },
      );
      await requestOrder(shill.id);
      await addMember(t.app, shill.s.shop.id, shill.users[1].id, 'STAFF');
      await deliver(
        orderCancelledEnvelope({
          orderId: (await auction(shill.id)).winnerOrderId!,
          userId: shill.users[0].id,
          orderVersion: 3,
        }),
      );
      expect(await auction(shill.id)).toMatchObject({
        status: 'UNSOLD',
        statusReason: 'winner_unpaid',
      });
    });

    it('S21 AS-38: when the best runner-up is ineligible a lower eligible bidder gets the offer at their own maximum', async () => {
      const { s, id, users, first } = await withFirstOrder();
      await addMember(t.app, s.shop.id, users[1].id, 'STAFF'); // U2 (5000) is now a member of the selling shop
      await deliver(
        orderCancelledEnvelope({
          orderId: first,
          userId: users[0].id,
          orderVersion: 3,
        }),
      );
      expect(await auction(id)).toMatchObject({
        status: 'SECOND_CHANCE',
        winnerId: users[2].id,
        finalPriceMinor: '3000',
      });
    });

    it('S21 AS-39: a second order.cancelled for the first order gives one offer only', async () => {
      const { id, users, first } = await withFirstOrder();
      await Promise.all([
        deliver(
          orderCancelledEnvelope({
            orderId: first,
            userId: users[0].id,
            orderVersion: 3,
          }),
        ),
        deliver(
          orderCancelledEnvelope({
            orderId: first,
            userId: users[0].id,
            orderVersion: 3,
          }),
        ),
      ]);
      await deliver(
        orderCancelledEnvelope({
          orderId: first,
          userId: users[0].id,
          orderVersion: 3,
        }),
      );
      expect(
        (await eventTypes(id)).filter(
          (x) => x === 'auction.second_chance_offered',
        ),
      ).toHaveLength(1);
      expect(
        await t.probe.find('auctions.request-order', {
          auctionId: id,
          step: 'second-chance',
        }),
      ).toHaveLength(1);
      expect(
        (await history(id)).filter((h) => h.toStatus === 'SECOND_CHANCE'),
      ).toHaveLength(1);
    });

    it('S21 AS-39: a late payment of the first order after the offer began is an anomaly, not a transition', async () => {
      const { id, users, first } = await withFirstOrder();
      await deliver(
        orderCancelledEnvelope({
          orderId: first,
          userId: users[0].id,
          orderVersion: 3,
        }),
      );
      const before =
        MetricsRegistry.value('auction_settlement_anomaly_total', {
          kind: 'late_payment',
        }) ?? 0;
      const version = (await auction(id)).version;
      await deliver(
        orderPaidEnvelope({
          orderId: first,
          userId: users[0].id,
          totalMinor: 5500,
          orderVersion: 4,
        }),
      );
      expect(
        MetricsRegistry.value('auction_settlement_anomaly_total', {
          kind: 'late_payment',
        }),
      ).toBe(before + 1);
      expect(await auction(id)).toMatchObject({
        status: 'SECOND_CHANCE',
        version,
      });
    });

    it('S21 AS-39: the offer paid before its order ID is stored is held for redelivery, then applied once', async () => {
      const { id, users, first } = await withFirstOrder();
      await deliver(
        orderCancelledEnvelope({
          orderId: first,
          userId: users[0].id,
          orderVersion: 3,
        }),
      );

      // the command creates the order but the answer is not recorded (the store of the ID fails once)
      const real = t.app.get<AuctionRepository>(AUCTION_REPOSITORY, {
        strict: false,
      });
      let failures = 1;
      t.patch(
        real,
        'storeOrder',
        (original) =>
          ((...args: Parameters<typeof real.storeOrder>) => {
            if (failures-- > 0) return Promise.reject(new Error('answer lost'));
            return original(...args);
          }) as never,
      );
      await expect(requestOrder(id, 'second-chance')).rejects.toThrow(
        'answer lost',
      );
      const [offer] = await ordersOf(users[1].id);
      expect((await auction(id)).winnerOrderId).toBeNull();

      const paid = orderPaidEnvelope({
        orderId: offer.id,
        userId: users[1].id,
        totalMinor: 5000,
        orderVersion: 2,
      });
      await expect(deliver(paid)).rejects.toThrow(/not stored yet/); // held: not acknowledged as done
      expect((await auction(id)).status).toBe('SECOND_CHANCE');

      await requestOrder(id, 'second-chance'); // the retry stores the ID (the command replays the same order)
      expect((await auction(id)).winnerOrderId).toBe(offer.id);
      await deliver(paid);
      await deliver(paid);
      expect((await auction(id)).status).toBe('SOLD');
      expect(
        (await eventTypes(id)).filter((x) => x === 'auction.sold'),
      ).toHaveLength(1);
    });

    it('S21 AS-39: a message with a lower orderVersion than one already applied is ignored; terminal auctions ignore every message', async () => {
      const { id, users, first } = await withFirstOrder();
      await exec(
        t.app,
        `UPDATE "Auction" SET "settlementOrderVersion" = 7 WHERE "id" = :id`,
        { id },
      );
      await deliver(
        orderCancelledEnvelope({
          orderId: first,
          userId: users[0].id,
          orderVersion: 6,
        }),
      );
      expect((await auction(id)).status).toBe('CLOSED');
      await deliver(
        orderCancelledEnvelope({
          orderId: first,
          userId: users[0].id,
          orderVersion: 8,
        }),
      );
      expect((await auction(id)).status).toBe('SECOND_CHANCE');

      await requestOrder(id, 'second-chance');
      const offer = (await auction(id)).winnerOrderId!;
      await deliver(
        orderPaidEnvelope({
          orderId: offer,
          userId: users[1].id,
          totalMinor: 5000,
          orderVersion: 2,
        }),
      );
      expect((await auction(id)).status).toBe('SOLD');
      const frozen = await auction(id);
      await deliver(
        orderCancelledEnvelope({
          orderId: offer,
          userId: users[1].id,
          orderVersion: 9,
        }),
        orderCancelledEnvelope({
          orderId: first,
          userId: users[0].id,
          orderVersion: 10,
        }),
        orderPaidEnvelope({
          orderId: first,
          userId: users[0].id,
          totalMinor: 5500,
          orderVersion: 11,
        }),
      );
      expect(await auction(id)).toEqual(frozen);
    });
  });
});
