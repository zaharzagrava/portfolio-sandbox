import { randomUUID } from 'node:crypto';
import {
  auctionEventSchemas,
  bidResultSchema,
  myBidSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import type { TestUser } from '@app/test/utils/catalog-app';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  createAuctionsApp,
  exec,
  fastStoreOf,
  rows,
  seedAuction,
  seedSeller,
  type AuctionTestApp,
  type FastStore,
} from './testing/auction-app';

const MIN = 60_000;
const T = new Date('2026-10-14T12:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms);

describe('Auctions: proxy bidding, server clock, idempotency and concurrency', () => {
  let t: AuctionTestApp;
  let fast: FastStore;
  const counter = 0;

  beforeAll(async () => {
    t = await createAuctionsApp();
    fast = fastStoreOf(t.app);
  });
  afterAll(async () => {
    await fast.allow();
    await t.close();
  });
  beforeEach(async () => {
    await fast.allow();
    await t.reset();
    await fast.clearRateLimits();
    await t.setTime(T);
  });

  /** DS-1: shop S1 with a product (EUR 200.00, stock 3) and auction A, `OPEN` at `T`, version 0. */
  const dataset = async (
    over: Partial<Parameters<typeof seedAuction>[1]> = {},
  ) => {
    const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 3 }]);
    const id = await seedAuction(t.app, {
      shopId: s.shop.id,
      productId: s.products[0].id,
      startsAt: T,
      endsAt: at(60 * MIN),
      ...over,
    });
    return { s, id };
  };
  const bid = (
    user: TestUser,
    id: string,
    max: unknown,
    key: string = `bid-${randomUUID()}`,
  ) =>
    t
      .as(user)
      .post(`/api/auctions/${id}/bids`)
      .set('Idempotency-Key', key)
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
  const bidRows = (id: string) =>
    rows<{
      bidderId: string;
      maxAmountMinor: string;
      outcome: string;
      priceAfterMinor: string;
      sequence: number;
    }>(
      t.app,
      `SELECT "bidderId", "maxAmountMinor", "outcome", "priceAfterMinor", "sequence" FROM "Bid" WHERE "auctionId" = :id ORDER BY "sequence"`,
      { id },
    );
  const auctionRow = async (id: string) =>
    (
      await rows<{
        status: string;
        priceMinor: string;
        leaderId: string | null;
        leaderMaxMinor: string | null;
        bidCount: number;
        version: number;
        endsAt: Date;
      }>(
        t.app,
        `SELECT "status", "priceMinor", "leaderId", "leaderMaxMinor", "bidCount", "version", "endsAt" FROM "Auction" WHERE "id" = :id`,
        { id },
      )
    )[0];
  const events = async (id: string) => await outboxRowsFor(t.app, id);
  const eventTypes = async (id: string) =>
    (await events(id)).map((e) => e.type);
  const payloadOf = (row: { payload: Record<string, unknown> }) =>
    (row.payload as { payload: Record<string, unknown> }).payload;
  const priceMessages = () =>
    t.realtime.published.filter((m) => m.type === 'price');

  describe('first bid (AS-10)', () => {
    it('S21 AS-10: 200 with the result, one bid row, the auction row, bid_placed and no leader_changed, a price push after the commit', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      await t.setTime(at(10 * MIN));
      const res = await bid(u1, id, 10_000, 'k1-aaaa-0001');

      expect(res.status).toBe(200);
      const result = bidResultSchema.parse(res.body);
      expect(result).toMatchObject({
        outcome: 'leading',
        priceMinor: 1000,
        youAreLeading: true,
        endsAt: at(60 * MIN).toISOString(),
        version: 1,
        serverTime: at(10 * MIN).toISOString(),
        minimumNextMaxMinor: 1500,
        reserveMet: false,
        hasReserve: false,
      });
      expect(result.leaderAlias).toMatch(/^Bidder /);

      expect(await bidRows(id)).toEqual([
        {
          bidderId: u1.id,
          maxAmountMinor: '10000',
          outcome: 'leading',
          priceAfterMinor: '1000',
          sequence: 1,
        },
      ]);
      expect(await auctionRow(id)).toMatchObject({
        status: 'OPEN',
        priceMinor: '1000',
        leaderId: u1.id,
        leaderMaxMinor: '10000',
        bidCount: 1,
        version: 1,
      });
      expect(await eventTypes(id)).toEqual(['auction.bid_placed']);
      const [placed] = await events(id);
      expect(
        auctionEventSchemas['auction.bid_placed'].parse(payloadOf(placed)),
      ).toMatchObject({
        bidderId: u1.id,
        outcome: 'leading',
        priceMinor: 1000,
        leaderId: u1.id,
        extended: false,
        sequence: 1,
        auctionVersion: 1,
      });
      expect(priceMessages()).toHaveLength(1);
      expect(priceMessages()[0]).toMatchObject({
        topic: `auction:${id}`,
        data: {
          auctionId: id,
          priceMinor: 1000,
          version: 1,
          reserveMet: false,
        },
      });
    });
  });

  describe('proxy resolution (AS-11 – AS-15)', () => {
    /** The table of AS-11, played through HTTP. */
    const playTable = async (id: string, [u1, u2, u3]: TestUser[]) => {
      const a = await bid(u1, id, 10_000);
      const b = await bid(u2, id, 5000);
      const c = await bid(u3, id, 12_000);
      const d = await bid(u1, id, 10_400);
      const e = await bid(u1, id, 11_000);
      return { a, b, c, d, e };
    };

    it('S21 AS-11: the four-step table, exact prices and leaders, gapless rows, leader_changed only on the real change', async () => {
      const { id } = await dataset();
      const users = await bidders(3);
      const [u1, u2, u3] = users;
      const { a, b, c, d, e } = await playTable(id, users);

      expect([a.status, b.status, c.status, d.status, e.status]).toEqual([
        200, 200, 200, 422, 200,
      ]);
      expect(a.body).toMatchObject({ outcome: 'leading', priceMinor: 1000 });
      expect(b.body).toMatchObject({
        outcome: 'outbid',
        priceMinor: 5500,
        youAreLeading: false,
      });
      expect(c.body).toMatchObject({
        outcome: 'leading',
        priceMinor: 10_500,
        youAreLeading: true,
      });
      expect(d.body).toMatchObject({
        code: 'bid_too_low',
        minimumMaxAmountMinor: 11_000,
      });
      expect(e.body).toMatchObject({
        outcome: 'outbid',
        priceMinor: 11_500,
        youAreLeading: false,
      });

      const log = await bidRows(id);
      expect(
        log.map((r) => [
          r.bidderId,
          r.maxAmountMinor,
          r.sequence,
          r.priceAfterMinor,
        ]),
      ).toEqual([
        [u1.id, '10000', 1, '1000'],
        [u2.id, '5000', 2, '5500'],
        [u3.id, '12000', 3, '10500'],
        [u1.id, '11000', 4, '11500'],
      ]);
      // the price never decreased
      const prices = log.map((r) => Number(r.priceAfterMinor));
      expect(prices).toEqual([...prices].sort((x, y) => x - y));
      expect(await auctionRow(id)).toMatchObject({
        leaderId: u3.id,
        priceMinor: '11500',
        bidCount: 4,
        version: 4,
      });

      expect(await eventTypes(id)).toEqual([
        'auction.bid_placed',
        'auction.bid_placed',
        'auction.bid_placed',
        'auction.leader_changed',
        'auction.bid_placed',
      ]);
      const changed = (await events(id)).find(
        (x) => x.type === 'auction.leader_changed',
      )!;
      expect(
        auctionEventSchemas['auction.leader_changed'].parse(payloadOf(changed)),
      ).toMatchObject({
        previousLeaderId: u1.id,
        leaderId: u3.id,
        priceMinor: 10_500,
      });
    });

    it('S21 AS-12: a tie goes to the earlier bidder, the minimum takes the lead, 12999 is too low', async () => {
      const { id } = await dataset();
      const users = await bidders(3);
      const [, u2, u3] = users;
      await playTable(id, users);

      const tie = await bid(u2, id, 12_000);
      expect(tie.status).toBe(200);
      expect(tie.body).toMatchObject({
        outcome: 'outbid',
        priceMinor: 12_000,
        youAreLeading: false,
      });
      expect((await auctionRow(id)).leaderId).toBe(u3.id);
      expect(await eventTypes(id)).toHaveLength(6); // five from the table + this bid_placed, no leader_changed

      const win = await bid(u2, id, 12_500);
      expect(win.body).toMatchObject({
        outcome: 'leading',
        priceMinor: 12_500,
        youAreLeading: true,
      });
      const last = (await events(id))
        .filter((x) => x.type === 'auction.leader_changed')
        .pop()!;
      expect(payloadOf(last)).toMatchObject({
        previousLeaderId: u3.id,
        leaderId: u2.id,
        priceMinor: 12_500,
      });

      const low = await bid(u3, id, 12_999);
      expect(low.status).toBe(422);
      expect(low.body).toMatchObject({
        code: 'bid_too_low',
        minimumMaxAmountMinor: 13_000,
      });
    });

    it('S21 AS-13: the reserve is hidden and met when a maximum covers it', async () => {
      const first = await dataset({ reservePriceMinor: 3000 });
      const [u1, u2] = await bidders(2);
      const a = await bid(u1, first.id, 2500);
      expect(a.body).toMatchObject({
        outcome: 'leading',
        priceMinor: 1000,
        reserveMet: false,
        hasReserve: true,
      });
      const b = await bid(u2, first.id, 4000);
      expect(b.body).toMatchObject({
        outcome: 'leading',
        priceMinor: 3000,
        reserveMet: true,
        hasReserve: true,
      });

      const second = await dataset({ reservePriceMinor: 3000 });
      const direct = await bid(u1, second.id, 4000);
      expect(direct.body).toMatchObject({ priceMinor: 3000, reserveMet: true });

      const third = await dataset({ reservePriceMinor: 3000 });
      const below = await bid(u1, third.id, 2999);
      expect(below.body).toMatchObject({ priceMinor: 1000, reserveMet: false });
    });

    it('S21 AS-13: the reserve amount appears in no body, event or message (serialized-output scan)', async () => {
      const { id } = await dataset({ reservePriceMinor: 3333 });
      const [u1, u2] = await bidders(2);
      const responses = [
        await bid(u1, id, 2500),
        await bid(u2, id, 3000),
        await bid(u1, id, 2800),
      ];
      const mine = await t.as(u1).get(`/api/auctions/${id}/my-bid`);
      const scan = JSON.stringify([
        responses.map((r) => r.body),
        mine.body,
        (await events(id)).map((e) => e.payload),
        t.realtime.published,
      ]);
      expect(scan).not.toContain('3333');
      expect(scan).not.toMatch(/reservePrice/);
    });

    it('S21 AS-14: the leader raises their maximum without moving price or end; equal or lower is bid_not_increasing', async () => {
      const { id } = await dataset();
      const [, u2, u3] = await bidders(3);
      await bid(u3, id, 12_000);
      await bid(u2, id, 12_000); // equal maximum: the earlier bidder keeps the lead at price 12000
      await t.setTime(at(10 * MIN));
      const before = await auctionRow(id);
      expect(before).toMatchObject({
        leaderId: u3.id,
        priceMinor: '12000',
        bidCount: 2,
      });

      const raised = await bid(u3, id, 15_000);
      expect(raised.status).toBe(200);
      expect(raised.body).toMatchObject({
        outcome: 'raised',
        priceMinor: 12_000,
        youAreLeading: true,
        endsAt: at(60 * MIN).toISOString(),
      });
      expect(await auctionRow(id)).toMatchObject({
        bidCount: 3,
        priceMinor: '12000',
        leaderMaxMinor: '15000',
      });
      expect(
        (await events(id)).filter((e) => e.type === 'auction.bid_placed'),
      ).toHaveLength(3);
      expect(
        (await events(id)).filter((e) => e.type === 'auction.leader_changed'),
      ).toHaveLength(0);
      expect(payloadOf((await events(id)).pop()!)).toMatchObject({
        outcome: 'raised',
        extended: false,
      });

      for (const amount of [15_000, 14_000]) {
        const res = await bid(u3, id, amount);
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({
          code: 'bid_not_increasing',
          currentMaxAmountMinor: 15_000,
        });
      }
      expect(
        (await bidRows(id)).filter((r) => r.bidderId === u3.id),
      ).toHaveLength(2);
      expect((await auctionRow(id)).bidCount).toBe(3);
    });

    it('S21 AS-15: the minimum bids, and a rejected bid leaves no row, event or version change', async () => {
      const { id } = await dataset();
      const [u1, u2] = await bidders(2);
      const snapshot = async () => ({
        rows: (await bidRows(id)).length,
        events: (await events(id)).length,
        auction: await auctionRow(id),
        pushes: priceMessages().length,
      });

      const empty = await snapshot();
      const low = await bid(u1, id, 999);
      expect(low.status).toBe(422);
      expect(low.body).toMatchObject({
        code: 'bid_too_low',
        minimumMaxAmountMinor: 1000,
      });
      expect(await snapshot()).toEqual(empty);

      const ok = await bid(u1, id, 1000);
      expect(ok.body).toMatchObject({ outcome: 'leading', priceMinor: 1000 });

      const held = await snapshot();
      const tooLow = await bid(u2, id, 1499);
      expect(tooLow.status).toBe(422);
      expect(tooLow.body).toMatchObject({ minimumMaxAmountMinor: 1500 });
      expect(await snapshot()).toEqual(held);

      const accepted = await bid(u2, id, 1500);
      expect(accepted.body).toMatchObject({
        outcome: 'leading',
        priceMinor: 1500,
      });
    });
  });

  describe('validation, authentication, unknown auction (AS-16)', () => {
    it.each([
      ['0', 0],
      ['negative', -5],
      ['fractional', 1.5],
      ['a string', '100'],
      ['above the limit', 1_000_000_001_000],
      ['missing', undefined],
    ])(
      'S21 AS-16: maxAmountMinor %s → 400 validation_failed naming the field, nothing recorded',
      async (_n, amount) => {
        const { id } = await dataset();
        const [u1] = await bidders(1);
        const res = await bid(u1, id, amount);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(JSON.stringify(res.body.errors)).toContain('maxAmountMinor');
        expect(await bidRows(id)).toEqual([]);
        expect((await auctionRow(id)).version).toBe(0);
      },
    );

    it('S21 AS-16: an unknown property (a client time) → 400, a malformed id → 400, no credentials → 401, unknown auction → 404', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      const extra = await t
        .as(u1)
        .post(`/api/auctions/${id}/bids`)
        .set('Idempotency-Key', 'bid-key-0001')
        .send({ maxAmountMinor: 5000, clientTime: at(0).toISOString() });
      expect(extra.status).toBe(400);
      expect((await bid(u1, 'not-a-uuid', 5000)).status).toBe(400);
      const anonymous = await t
        .http()
        .post(`/api/auctions/${id}/bids`)
        .set('Idempotency-Key', 'bid-key-0002')
        .send({ maxAmountMinor: 5000 });
      expect(anonymous.status).toBe(401);
      const unknown = await bid(u1, randomUUID(), 5000);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('auction_not_found');
      expect(await bidRows(id)).toEqual([]);
      expect((await auctionRow(id)).version).toBe(0);
    });
  });

  describe('the server clock decides (AS-17)', () => {
    it('S21 AS-17: before the start 409 auction_not_started; at the start the bid opens the auction once; the open job is then a no-op', async () => {
      const { id } = await dataset({ status: 'SCHEDULED' });
      const [u1, u2] = await bidders(2);
      await t.setTime(new Date(T.getTime() - 1000));
      const early = await bid(u1, id, 5000);
      expect(early.status).toBe(409);
      expect(early.body).toMatchObject({
        code: 'auction_not_started',
        startsAt: T.toISOString(),
      });
      expect(await bidRows(id)).toEqual([]);
      expect((await auctionRow(id)).status).toBe('SCHEDULED');

      await t.setTime(T);
      const first = await bid(u1, id, 5000);
      expect(first.status).toBe(200);
      expect((await auctionRow(id)).status).toBe('OPEN');
      await t.jobs.open({ auctionId: id });
      await bid(u2, id, 6000);
      expect(
        (await eventTypes(id)).filter((x) => x === 'auction.opened'),
      ).toHaveLength(1);
      const history = await rows<{ toStatus: string }>(
        t.app,
        `SELECT "toStatus" FROM "AuctionHistory" WHERE "auctionId" = :id`,
        { id },
      );
      expect(history.map((h) => h.toStatus)).toEqual(['OPEN']);
    });

    it('S21 AS-17: accepted at endsAt − 1 ms, 409 auction_closed at endsAt and later with the real status; a client time changes nothing', async () => {
      // the extension cap is already reached (original end + 60 min), so the last bid cannot move the end
      const { id } = await dataset({ originalEndsAt: T });
      const [u1, u2] = await bidders(2);
      await t.setTime(at(60 * MIN - 1));
      const last = await bid(u1, id, 5000);
      expect(last.status).toBe(200);
      expect(last.body.serverTime).toBe(at(60 * MIN - 1).toISOString());

      for (const when of [at(60 * MIN), at(61 * MIN)]) {
        await t.setTime(when);
        const res = await t
          .as(u2)
          .post(`/api/auctions/${id}/bids`)
          .set('Idempotency-Key', `late-${randomUUID()}`)
          .set('X-Client-Time', at(0).toISOString())
          .send({ maxAmountMinor: 9000 });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'auction_closed',
          auctionStatus: 'OPEN',
        });
      }
      expect(await bidRows(id)).toHaveLength(1);
    });

    it.each(['CLOSED', 'UNSOLD', 'SOLD', 'SECOND_CHANCE', 'CANCELLED'])(
      'S21 AS-17: a %s auction → 409 auction_closed with its status',
      async (status) => {
        const { id } = await dataset({ status });
        const [u1] = await bidders(1);
        const res = await bid(u1, id, 5000);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'auction_closed',
          auctionStatus: status,
        });
        expect(await bidRows(id)).toEqual([]);
      },
    );

    it('S21 AS-06: a bid on an auction cancelled for a failed hold → 409 auction_closed', async () => {
      const { id, s } = await dataset({ status: 'SCHEDULED', unitHeld: false });
      const [u1] = await bidders(1);
      await exec(
        t.app,
        `UPDATE "Auction" SET "status" = 'CANCELLED', "statusReason" = 'stock_hold_failed' WHERE "id" = :id`,
        { id },
      );
      expect(s.shop.id).toBeTruthy();
      const res = await bid(u1, id, 5000);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'auction_closed',
        auctionStatus: 'CANCELLED',
      });
    });
  });

  describe('idempotent bid (AS-18)', () => {
    it('S21 AS-18: a sequential replay answers the original body with Idempotency-Replayed, even after the auction closed', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      const first = await bid(u1, id, 10_000, 'bid-key-aaaa1');
      const again = await bid(u1, id, 10_000, 'bid-key-aaaa1');
      expect(again.status).toBe(200);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(await bidRows(id)).toHaveLength(1);
      expect(await eventTypes(id)).toHaveLength(1);
      expect((await auctionRow(id)).version).toBe(1);

      await exec(
        t.app,
        `UPDATE "Auction" SET "status" = 'CLOSED' WHERE "id" = :id`,
        { id },
      );
      const late = await bid(u1, id, 10_000, 'bid-key-aaaa1');
      expect(late.status).toBe(200);
      expect(late.body).toEqual(first.body);
      expect(await bidRows(id)).toHaveLength(1);
    });

    it('S21 AS-18: five identical requests at once → 200 or 409 idempotency_in_flight, one bid row', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => bid(u1, id, 10_000, 'bid-key-bbbb2')),
      );
      for (const r of results) expect([200, 409]).toContain(r.status);
      for (const r of results.filter((x) => x.status === 409)) {
        expect(r.body.code).toBe('idempotency_in_flight');
        expect(r.headers['retry-after']).toBe('1');
      }
      expect(
        results.filter((r) => r.status === 200).length,
      ).toBeGreaterThanOrEqual(1);
      expect(await bidRows(id)).toHaveLength(1);
    });

    it('S21 AS-18: the key reused with another amount → 422; no key → 422; a malformed key → 422', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      await bid(u1, id, 10_000, 'bid-key-cccc3');
      const reuse = await bid(u1, id, 11_000, 'bid-key-cccc3');
      expect(reuse.status).toBe(422);
      expect(reuse.body.code).toBe('idempotency_key_reuse');
      const none = await t
        .as(u1)
        .post(`/api/auctions/${id}/bids`)
        .send({ maxAmountMinor: 12_000 });
      expect(none.status).toBe(422);
      expect(none.body.code).toBe('idempotency_key_required');
      const bad = await bid(u1, id, 12_000, 'no');
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('idempotency_key_invalid');
      expect(await bidRows(id)).toHaveLength(1);
    });

    it('S21 AS-18: another user replaying the key is a different principal: a fresh bid, never the stored body', async () => {
      const { id } = await dataset();
      const [u1, u2] = await bidders(2);
      const mine = await bid(u1, id, 10_000, 'bid-key-dddd4');
      const theirs = await bid(u2, id, 12_000, 'bid-key-dddd4');
      expect(theirs.status).toBe(200);
      expect(theirs.headers['idempotency-replayed']).toBeUndefined();
      expect(theirs.body).not.toEqual(mine.body);
      expect(theirs.body.youAreLeading).toBe(true);
      expect(await bidRows(id)).toHaveLength(2);
    });
  });

  describe('a hot auction (AS-19, AS-20)', () => {
    it('S21 AS-19: 50 bidders at once, 50 times: the highest maximum leads at second + increment, sequences gapless, rows = events = count', async () => {
      const users = await bidders(50);
      const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 3 }]);
      let previous: string | null = null;
      for (let run = 0; run < 50; run++) {
        if (previous)
          await exec(
            t.app,
            `UPDATE "Auction" SET "status" = 'UNSOLD' WHERE "id" = :id`,
            { id: previous },
          );
        await fast.clearRateLimits();
        const id = await seedAuction(t.app, {
          shopId: s.shop.id,
          productId: s.products[0].id,
          startsAt: T,
          endsAt: at(60 * MIN),
        });
        previous = id;
        const results = await Promise.all(
          users.map((u, i) => bid(u, id, 10_000 + 1000 * i)),
        );
        for (const r of results) expect([200, 422]).toContain(r.status);

        const state = await auctionRow(id);
        expect(state.leaderId).toBe(users[49].id);
        expect(state.priceMinor).toBe('58500');
        const log = await bidRows(id);
        expect(log.map((r) => r.sequence)).toEqual(
          Array.from({ length: log.length }, (_, i) => i + 1),
        );
        expect(state.bidCount).toBe(log.length);
        expect(
          (await events(id)).filter((e) => e.type === 'auction.bid_placed'),
        ).toHaveLength(log.length);
        expect(log.filter((r) => r.outcome !== 'raised')).toHaveLength(
          log.length,
        );
        const prices = log.map((r) => Number(r.priceAfterMinor));
        expect(prices).toEqual([...prices].sort((x, y) => x - y));
        for (const r of results.filter((x) => x.status === 200)) {
          const row = log.find((l) => l.sequence === r.body.version);
          expect(row).toBeDefined();
          expect(Number(row!.priceAfterMinor)).toBe(r.body.priceMinor);
        }
        expect(results.filter((r) => r.status === 200)).toHaveLength(
          log.length,
        );
      }
    }, 600_000);

    it('S21 AS-20: equal maximums at once: one leading, one outbid, the earlier applied leads, price 8000, no leader_changed', async () => {
      const { id } = await dataset();
      const [u1, u2] = await bidders(2);
      const results = await Promise.all([bid(u1, id, 8000), bid(u2, id, 8000)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(results.map((r) => r.body.outcome).sort()).toEqual([
        'leading',
        'outbid',
      ]);
      const log = await bidRows(id);
      expect(log.map((r) => r.outcome)).toEqual(['leading', 'outbid']);
      expect(await auctionRow(id)).toMatchObject({
        leaderId: log[0].bidderId,
        priceMinor: '8000',
      });
      expect(
        (await events(id)).filter((e) => e.type === 'auction.leader_changed'),
      ).toEqual([]);
    });
  });

  describe('rate limit and limiter failure (AS-21)', () => {
    it('S21 AS-21: the 11th bid within 10 s → 429 with Retry-After, nothing recorded for it', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      for (let i = 0; i < 10; i++)
        expect((await bid(u1, id, 10_000 + 100 * i)).status).toBe(200);
      const eleventh = await bid(u1, id, 20_000);
      expect(eleventh.status).toBe(429);
      expect(eleventh.body.code).toBe('rate_limited');
      expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);
      expect(await bidRows(id)).toHaveLength(10);
    });

    it('S21 AS-21: the limiter store down → 503 bid_unavailable with Retry-After: 2, nothing recorded', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      await fast.deny('rl:');
      const res = await bid(u1, id, 10_000);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('bid_unavailable');
      expect(res.headers['retry-after']).toBe('2');
      expect(await bidRows(id)).toEqual([]);
      expect((await auctionRow(id)).version).toBe(0);
      await fast.allow();
      expect((await bid(u1, id, 10_000)).status).toBe(200);
    });
  });

  describe('durability and degradation (AS-22, AS-23)', () => {
    it('S21 AS-22: after a full flush of the fast store and a failing realtime transport the next bid is decided from the durable record', async () => {
      const { id } = await dataset();
      const [u1, u2, u3] = await bidders(3);
      await bid(u1, id, 10_000);
      await bid(u2, id, 5000);
      await bid(u3, id, 12_000);
      await fast.flushAll();
      t.realtime.down = true;
      const failedBefore =
        MetricsRegistry.value('auction_realtime_failed_total') ?? 0;

      const next = await bid(u1, id, 11_000);
      expect(next.status).toBe(200);
      expect(next.body).toMatchObject({
        outcome: 'outbid',
        priceMinor: 11_500,
        youAreLeading: false,
      });
      expect(await bidRows(id)).toHaveLength(4);
      expect(await eventTypes(id)).toContain('auction.bid_placed');
      expect(
        (await events(id)).filter((e) => e.type === 'auction.bid_placed'),
      ).toHaveLength(4);
      expect(
        MetricsRegistry.value('auction_realtime_failed_total') ?? 0,
      ).toBeGreaterThan(failedBefore);
      expect(await auctionRow(id)).toMatchObject({ bidCount: 4, version: 4 });
    });

    it('S21 AS-23: a refused outbox append rolls the bid back: 500, no row, state unchanged, nothing pushed; the retry with the same key is a first attempt', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      const restore = t.patch(
        t.app.get(OutboxService),
        'append',
        () => (() => Promise.reject(new Error('outbox refused'))) as never,
      );
      const before = await auctionRow(id);
      const failed = await bid(u1, id, 10_000, 'bid-key-eeee5');
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toMatch(
        /outbox refused|Error:|at /,
      );
      expect(await bidRows(id)).toEqual([]);
      expect(await auctionRow(id)).toEqual(before);
      expect(priceMessages()).toEqual([]);

      restore();
      const retry = await bid(u1, id, 10_000, 'bid-key-eeee5');
      expect(retry.status).toBe(200);
      expect(retry.headers['idempotency-replayed']).toBeUndefined();
      expect(await bidRows(id)).toHaveLength(1);
    });
  });

  describe('my bid (used by the specs above)', () => {
    it('S21 AS-47: the caller sees only their own maximum', async () => {
      const { id } = await dataset();
      const [u1, u2] = await bidders(2);
      await bid(u1, id, 10_000);
      await bid(u2, id, 5000);
      const mine = await t.as(u1).get(`/api/auctions/${id}/my-bid`);
      expect(myBidSchema.parse(mine.body)).toEqual({
        maxAmountMinor: 10_000,
        isLeading: true,
        priceMinor: 5500,
      });
      const theirs = await t.as(u2).get(`/api/auctions/${id}/my-bid`);
      expect(theirs.body).toEqual({
        maxAmountMinor: 5000,
        isLeading: false,
        priceMinor: 5500,
      });
      const [u3] = await bidders(1);
      const stranger = await t.as(u3).get(`/api/auctions/${id}/my-bid`);
      expect(stranger.body).toEqual({
        maxAmountMinor: null,
        isLeading: false,
        priceMinor: 5500,
      });
      expect((await t.http().get(`/api/auctions/${id}/my-bid`)).status).toBe(
        401,
      );
      void counter;
    });
  });
});
