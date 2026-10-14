import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  auctionClosedMessageSchema,
  auctionPriceMessageSchema,
  auctionPublicSchema,
  bidHistoryPageSchema,
  myBidSchema,
} from '@marketplace-sandbox/contracts';
import type { TestUser } from '@app/test/utils/catalog-app';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import {
  createAuctionsApp,
  fastStoreOf,
  rows,
  seedAuction,
  seedSeller,
  type AuctionTestApp,
  type FastStore,
} from './testing/auction-app';

const MIN = 60_000;
const T = new Date('2026-10-14T12:00:00.000Z');
const E = new Date(T.getTime() + 60 * MIN);

describe('Auctions: public view, bid history, my bid and live price push', () => {
  let t: AuctionTestApp;
  let fast: FastStore;

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

  const dataset = async (
    over: Partial<Parameters<typeof seedAuction>[1]> = {},
  ) => {
    const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 2 }]);
    const id = await seedAuction(t.app, {
      shopId: s.shop.id,
      productId: s.products[0].id,
      startsAt: T,
      endsAt: E,
      originalEndsAt: T,
      ...over,
    });
    return { s, id };
  };
  const bid = (user: TestUser, id: string, max: number) =>
    t
      .as(user)
      .post(`/api/auctions/${id}/bids`)
      .set('Idempotency-Key', `bid-${randomUUID()}`)
      .send({ maxAmountMinor: max });
  const bidders = async (n: number) => {
    const out: TestUser[] = [];
    for (let i = 0; i < n; i++) out.push(await t.user());
    return out;
  };
  /** The table of AS-11: U1 10000, U2 5000, U3 12000, U1 10400 (rejected), U1 11000. */
  const playTable = async (id: string, [u1, u2, u3]: TestUser[]) => {
    const statuses = [
      (await bid(u1, id, 10_000)).status,
      (await bid(u2, id, 5000)).status,
      (await bid(u3, id, 12_000)).status,
      (await bid(u1, id, 10_400)).status,
      (await bid(u1, id, 11_000)).status,
    ];
    expect(statuses).toEqual([200, 200, 200, 422, 200]);
  };
  const view = (id: string) => t.http().get(`/api/auctions/${id}`);

  describe('the public view (AS-43)', () => {
    it('S21 AS-43: anonymous 200 with the public fields and Cache-Control; no user id, maximum or reserve amount', async () => {
      const { id, s } = await dataset({ reservePriceMinor: 3333 });
      const users = await bidders(3);
      await playTable(id, users);
      await t.setTime(new Date(T.getTime() + 10 * MIN));

      const res = await view(id);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, s-maxage=1');
      const body = auctionPublicSchema.parse(res.body);
      expect(body).toMatchObject({
        auctionId: id,
        productId: s.products[0].id,
        shopId: s.shop.id,
        currency: 'EUR',
        status: 'OPEN',
        priceMinor: 11_500,
        minimumNextMaxMinor: 12_000,
        bidCount: 4,
        hasReserve: true,
        reserveMet: true,
        version: 4,
        serverTime: new Date(T.getTime() + 10 * MIN).toISOString(),
      });
      const scan = JSON.stringify(res.body);
      for (const u of users) expect(scan).not.toContain(u.id);
      expect(scan).not.toMatch(/maxAmount|leaderMax|leaderId|reservePrice/);
      expect(scan).not.toContain('3333');
    });

    it('S21 AS-43: the alias is stable within one auction, differs between bidders and across auctions, and is not an id', async () => {
      const first = await dataset();
      const second = await dataset();
      const [u1, u2] = await bidders(2);
      await bid(u1, first.id, 5000);
      const a1 = (await view(first.id)).body.leaderAlias as string;
      await bid(u2, first.id, 9000);
      const a2 = (await view(first.id)).body.leaderAlias as string;
      await bid(u1, second.id, 5000);
      const other = (await view(second.id)).body.leaderAlias as string;

      expect(a1).toMatch(/^Bidder [0-9A-Z]{6}$/);
      expect(a1).not.toBe(a2);
      expect(other).not.toBe(a1);
      await bid(u1, first.id, 12_000); // u1 leads again: the same alias as the first time
      expect((await view(first.id)).body.leaderAlias).toBe(a1);
      expect([a1, a2, other].join()).not.toContain(u1.id);
    });

    it('S21 AS-43: a commit drops the cached entry: the next read has the new state', async () => {
      const { id } = await dataset();
      const [u1, u2] = await bidders(2);
      await bid(u1, id, 5000);
      expect((await view(id)).body).toMatchObject({ bidCount: 1, version: 1 });
      expect((await view(id)).body.version).toBe(1); // served from the cache
      await bid(u2, id, 9000);
      expect((await view(id)).body).toMatchObject({
        bidCount: 2,
        version: 2,
        priceMinor: 5500,
      });
    });

    it('S21 AS-43: an unknown auction is 404 auction_not_found, a malformed id 400', async () => {
      const res = await view(randomUUID());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('auction_not_found');
      expect((await view('nope')).status).toBe(400);
    });
  });

  describe('the batch for the BFF (AS-44)', () => {
    it('S21 AS-44: one public view per product, unknown products absent, in a single read of the table', async () => {
      const s = await seedSeller(t, [
        { priceMinor: 20_000, quantity: 2 },
        { priceMinor: 20_000, quantity: 2 },
        { priceMinor: 20_000, quantity: 2 },
      ]);
      const ids: string[] = [];
      for (const p of s.products.slice(0, 2))
        ids.push(
          await seedAuction(t.app, {
            shopId: s.shop.id,
            productId: p.id,
            startsAt: T,
            endsAt: E,
          }),
        );
      const [p1, p2, p3] = s.products;

      const statements: string[] = [];
      const sequelize = t.app.get(Sequelize);
      const restore = t.patch(
        sequelize,
        'query',
        (original) =>
          ((sql: unknown, ...rest: unknown[]) => {
            statements.push(
              typeof sql === 'string' ? sql : JSON.stringify(sql),
            );
            return (original as (...a: unknown[]) => unknown)(sql, ...rest);
          }) as never,
      );
      const res = await t
        .http()
        .get(
          `/api/auctions?productIds=${p1.id},${p2.id},${p3.id},${randomUUID()}`,
        );
      restore();

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, s-maxage=1');
      const items = res.body.map((x: unknown) => auctionPublicSchema.parse(x));
      expect(
        items.map((x: { productId: string }) => x.productId).sort(),
      ).toEqual([p1.id, p2.id].sort());
      expect(
        items.map((x: { auctionId: string }) => x.auctionId).sort(),
      ).toEqual([...ids].sort());
      expect(statements.filter((q) => /FROM "Auction"/.test(q))).toHaveLength(
        1,
      );
    });

    it('S21 AS-44: 101 ids or a malformed id → 400 validation_failed', async () => {
      const many = Array.from({ length: 101 }, () => randomUUID()).join(',');
      for (const query of [many, 'nope', `${randomUUID()},nope`, '']) {
        const res = await t.http().get(`/api/auctions?productIds=${query}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      }
      const exactly = Array.from({ length: 100 }, () => randomUUID()).join(',');
      expect(
        (await t.http().get(`/api/auctions?productIds=${exactly}`)).status,
      ).toBe(200);
    });

    it('S21 AS-44: terminal auctions older than a day are left out, a recent one stays', async () => {
      const s = await seedSeller(t, [
        { priceMinor: 20_000, quantity: 2 },
        { priceMinor: 20_000, quantity: 2 },
      ]);
      const recent = await seedAuction(t.app, {
        shopId: s.shop.id,
        productId: s.products[0].id,
        startsAt: new Date(T.getTime() - 3 * 24 * 60 * MIN),
        endsAt: new Date(T.getTime() - 60 * MIN),
        status: 'UNSOLD',
      });
      const old = await seedAuction(t.app, {
        shopId: s.shop.id,
        productId: s.products[1].id,
        startsAt: new Date(T.getTime() - 5 * 24 * 60 * MIN),
        endsAt: new Date(T.getTime() - 3 * 24 * 60 * MIN),
        status: 'UNSOLD',
      });
      await rows(t.app, `SELECT 1`);
      for (const [id, closedAt] of [
        [recent, new Date(T.getTime() - 60 * MIN)],
        [old, new Date(T.getTime() - 3 * 24 * 60 * MIN)],
      ] as const)
        await t.app
          .get(Sequelize)
          .query(
            `UPDATE "Auction" SET "closedAt" = :closedAt WHERE "id" = :id`,
            {
              replacements: { id, closedAt },
            },
          );
      const res = await t
        .http()
        .get(
          `/api/auctions?productIds=${s.products.map((p) => p.id).join(',')}`,
        );
      expect(res.body.map((x: { auctionId: string }) => x.auctionId)).toEqual([
        recent,
      ]);
    });
  });

  describe('reads survive the loss of the fast store (AS-45)', () => {
    it('S21 AS-45: the cache store refusing commands → 200 from the durable record, correct after a commit', async () => {
      const { id } = await dataset();
      const [u1, u2] = await bidders(2);
      await bid(u1, id, 5000);
      await fast.deny('auction:view:');
      const down = await view(id);
      expect(down.status).toBe(200);
      expect(down.body).toMatchObject({ bidCount: 1, version: 1 });
      await bid(u2, id, 9000);
      expect((await view(id)).body).toMatchObject({ bidCount: 2, version: 2 });
    });

    it('S21 AS-21: with the limiter store down the public reads still answer (fail open) while a bid is refused', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      await fast.deny('rl:');
      expect((await view(id)).status).toBe(200);
      expect((await t.http().get(`/api/auctions/${id}/bids`)).status).toBe(200);
      expect(
        (await t.http().get(`/api/auctions?productIds=${randomUUID()}`)).status,
      ).toBe(200);
      expect((await bid(u1, id, 5000)).status).toBe(503);

      // the limiter's breaker reads the injected clock: let its open window pass, then one probe closes it again
      await fast.allow();
      await t.setTime(new Date(T.getTime() + 5 * MIN));
      expect((await view(id)).status).toBe(200);
      await t.setTime(T);
    });
  });

  describe('the public bid history (AS-46)', () => {
    it('S21 AS-46: price-changing bids newest first with aliases, cursor pages, no maximum and no user id', async () => {
      const { id } = await dataset();
      const users = await bidders(3);
      await playTable(id, users);
      const page1 = await t.http().get(`/api/auctions/${id}/bids?limit=2`);
      expect(page1.status).toBe(200);
      const first = bidHistoryPageSchema.parse(page1.body);
      expect(
        first.items.map((i) => [i.sequence, i.priceMinor, i.outcome]),
      ).toEqual([
        [4, 11_500, 'outbid'],
        [3, 10_500, 'leading'],
      ]);
      expect(first.nextCursor).not.toBeNull();
      const second = bidHistoryPageSchema.parse(
        (
          await t
            .http()
            .get(`/api/auctions/${id}/bids?limit=2&cursor=${first.nextCursor}`)
        ).body,
      );
      expect(second.items.map((i) => i.sequence)).toEqual([2, 1]);
      expect(second.nextCursor).toBeNull();

      const scan = JSON.stringify([first, second]);
      for (const u of users) expect(scan).not.toContain(u.id);
      expect(scan).not.toMatch(/maxAmount|bidderId/);
      // the alias of U3 (the leader) shows on its bid and differs from U1's
      expect(first.items[1].bidderAlias).not.toBe(first.items[0].bidderAlias);
      expect(first.items[1].bidderAlias).toBe(
        (await view(id)).body.leaderAlias,
      );
    });

    it('S21 AS-46: raised bids are not listed; the default page is 20', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      await bid(u1, id, 5000);
      await bid(u1, id, 6000); // raised
      await bid(u1, id, 7000); // raised
      const res = await t.http().get(`/api/auctions/${id}/bids`);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        sequence: 1,
        outcome: 'leading',
      });

      const crowd = await dataset();
      const many = await bidders(25);
      for (let i = 0; i < 25; i++) {
        if (i % 8 === 0) await fast.clearRateLimits();
        await bid(many[i], crowd.id, 2000 + 600 * i);
      }
      const page = await t.http().get(`/api/auctions/${crowd.id}/bids`);
      expect(page.body.items).toHaveLength(20);
      expect(page.body.nextCursor).not.toBeNull();
    }, 120_000);

    it('S21 AS-46: limit 0 or 101 → 400 validation_failed, a tampered cursor → 400 invalid_cursor, an unknown auction → 404', async () => {
      const { id } = await dataset();
      const [u1, u2] = await bidders(2);
      await bid(u1, id, 5000);
      await bid(u2, id, 9000);
      for (const limit of [0, 101, 'x']) {
        const res = await t
          .http()
          .get(`/api/auctions/${id}/bids?limit=${limit}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      }
      const cursor = (await t.http().get(`/api/auctions/${id}/bids?limit=1`))
        .body.nextCursor as string;
      for (const bad of [`${cursor.slice(0, -2)}xx`, 'garbage']) {
        const res = await t
          .http()
          .get(`/api/auctions/${id}/bids?cursor=${bad}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_cursor');
      }
      const other = await dataset();
      await bid(u1, other.id, 5000);
      await bid(u2, other.id, 9000);
      const foreign = (
        await t.http().get(`/api/auctions/${other.id}/bids?limit=1`)
      ).body.nextCursor as string;
      expect(
        (await t.http().get(`/api/auctions/${id}/bids?cursor=${foreign}`))
          .status,
      ).toBe(400);
      const unknown = await t.http().get(`/api/auctions/${randomUUID()}/bids`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('auction_not_found');
    });

    it('S21 AS-46: the list is correct across a month boundary (rows in two partitions)', async () => {
      const month = 31 * 24 * 60 * MIN;
      const { id } = await dataset({
        endsAt: new Date(T.getTime() + 2 * month),
        originalEndsAt: T,
      });
      const [u1, u2] = await bidders(2);
      await t.jobs.ensureBidPartitions();
      expect((await bid(u1, id, 5000)).status).toBe(200);
      await t.setTime(new Date(T.getTime() + month + 5 * 24 * 60 * MIN));
      await t.jobs.ensureBidPartitions();
      expect((await bid(u2, id, 9000)).status).toBe(200);

      const parts = await rows<{ partition: string }>(
        t.app,
        `SELECT DISTINCT tableoid::regclass::text AS partition FROM "Bid" WHERE "auctionId" = :id`,
        { id },
      );
      expect(parts).toHaveLength(2);
      const res = await t.http().get(`/api/auctions/${id}/bids`);
      expect(
        res.body.items.map((i: { sequence: number }) => i.sequence),
      ).toEqual([2, 1]);
    });
  });

  describe('my bid (AS-47)', () => {
    it("S21 AS-47: only the caller's own maximum, never another user's, through any route", async () => {
      const { id } = await dataset();
      const [u1, u2, u3] = await bidders(3);
      await bid(u1, id, 10_000);
      await bid(u2, id, 5000);
      await bid(u3, id, 12_300);
      await bid(u1, id, 11_000);

      const mine = await t.as(u1).get(`/api/auctions/${id}/my-bid`);
      expect(myBidSchema.parse(mine.body)).toEqual({
        maxAmountMinor: 11_000,
        isLeading: false,
        priceMinor: 11_500,
      });
      const leader = await t.as(u3).get(`/api/auctions/${id}/my-bid`);
      expect(leader.body).toMatchObject({
        maxAmountMinor: 12_300,
        isLeading: true,
      });
      const stranger = await bidders(1);
      const none = await t.as(stranger[0]).get(`/api/auctions/${id}/my-bid`);
      expect(none.body).toMatchObject({
        maxAmountMinor: null,
        isLeading: false,
      });
      expect((await t.http().get(`/api/auctions/${id}/my-bid`)).status).toBe(
        401,
      );

      // a maximum appears nowhere else: not in the view, the history or a pushed message
      const everywhere = JSON.stringify([
        (await view(id)).body,
        (await t.http().get(`/api/auctions/${id}/bids`)).body,
        t.realtime.published,
      ]);
      for (const max of ['10000', '5000', '12300', '11000'])
        expect(everywhere).not.toContain(max);
    });
  });

  describe('the public rate limit (last: the limiter keeps local state for the window)', () => {
    it('S21 AS-45: the public reads are limited per address (policy auctions.read.ip)', async () => {
      const { id } = await dataset();
      let limited = 0;
      for (let i = 0; i < 620 && limited === 0; i += 20) {
        const batch = await Promise.all(
          Array.from({ length: 20 }, () => t.http().get(`/api/auctions/${id}`)),
        );
        limited += batch.filter((r) => r.status === 429).length;
      }
      expect(limited).toBeGreaterThan(0);
    }, 120_000);
  });

  describe('the live push (AS-48)', () => {
    it('S21 AS-48: a price message after each commit (never inside the transaction), the closed message without the winner, versions rising', async () => {
      const { id } = await dataset();
      const [u1, u2] = await bidders(2);

      // each publish checks, from outside the transaction, that the bid it announces is already committed
      const seen: Array<{ version: number; committed: boolean }> = [];
      const sequelize = t.app.get(Sequelize);
      const publisher = t.app.get(RealtimePublisher);
      t.patch(
        publisher,
        'publish',
        (original) =>
          (async (topic: string, type: string, data: { version: number }) => {
            if (type === 'price') {
              const [row] = await sequelize.query<{ version: number }>(
                `SELECT "version" FROM "Auction" WHERE "id" = :id`,
                { type: QueryTypes.SELECT, replacements: { id } },
              );
              seen.push({
                version: data.version,
                committed: row.version >= data.version,
              });
            }
            return (original as (...a: unknown[]) => unknown)(
              topic,
              type,
              data,
            );
          }) as never,
      );

      await bid(u1, id, 5000);
      await bid(u2, id, 9000);
      await bid(u1, id, 4000); // rejected: no push
      await t.setTime(E);
      await t.jobs.close({ auctionId: id });

      const prices = t.realtime.published.filter((m) => m.type === 'price');
      const closed = t.realtime.published.filter((m) => m.type === 'closed');
      expect(
        prices.map((m) => auctionPriceMessageSchema.parse(m.data).version),
      ).toEqual([1, 2]);
      expect(prices.every((m) => m.topic === `auction:${id}`)).toBe(true);
      expect(seen).toEqual([
        { version: 1, committed: true },
        { version: 2, committed: true },
      ]);
      expect(closed).toHaveLength(1);
      const message = auctionClosedMessageSchema.parse(closed[0].data);
      expect(message).toMatchObject({
        auctionId: id,
        status: 'CLOSED',
        finalPriceMinor: 5500,
      });
      expect(message.version).toBeGreaterThan(2);
      expect(JSON.stringify(closed)).not.toContain(u2.id);
    });
  });
});
