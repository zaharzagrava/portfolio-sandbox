import { randomUUID } from 'node:crypto';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  createAuctionsApp,
  fastStoreOf,
  rows,
  seedAuction,
  seedSeller,
  type AuctionTestApp,
  type FastStore,
} from './testing/auction-app';

const SEC = 1000;
const MIN = 60 * SEC;
const T = new Date('2026-10-14T12:00:00.000Z');
const E = new Date(T.getTime() + 60 * MIN); // the original end
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

describe('Auctions: anti-sniping extension', () => {
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

  const dataset = async (
    over: Partial<Parameters<typeof seedAuction>[1]> = {},
  ) => {
    const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 3 }]);
    const id = await seedAuction(t.app, {
      shopId: s.shop.id,
      productId: s.products[0].id,
      startsAt: T,
      endsAt: E,
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
    // 25 at a time: the users are separate rows and sessions
    for (let i = 0; i < n; i += 25)
      out.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(25, n - i) }, () => t.user()),
        )),
      );
    return out;
  };
  const endsAtOf = async (id: string) =>
    (
      await rows<{ endsAt: Date; originalEndsAt: Date }>(
        t.app,
        `SELECT "endsAt", "originalEndsAt" FROM "Auction" WHERE "id" = :id`,
        { id },
      )
    )[0];
  const events = (id: string) => outboxRowsFor(t.app, id);
  const lastPlaced = async (id: string) => {
    const placed = (await events(id)).filter(
      (e) => e.type === 'auction.bid_placed',
    );
    return (
      placed[placed.length - 1].payload as { payload: Record<string, unknown> }
    ).payload;
  };

  describe('extension and its limits (AS-24)', () => {
    it('S21 AS-24: a price-changing bid at E − 90 s moves the end to E + 30 s in the response, the row, the push and the event', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      await t.setTime(at(E, -90 * SEC));
      const res = await bid(u1, id, 5000);

      expect(res.status).toBe(200);
      expect(res.body.endsAt).toBe(at(E, 30 * SEC).toISOString());
      const row = await endsAtOf(id);
      expect(row.endsAt.toISOString()).toBe(at(E, 30 * SEC).toISOString());
      expect(row.originalEndsAt.toISOString()).toBe(E.toISOString());
      expect(await lastPlaced(id)).toMatchObject({
        extended: true,
        endsAt: at(E, 30 * SEC).toISOString(),
      });
      const push = t.realtime.published
        .filter((m) => m.type === 'price')
        .pop()!;
      expect(push.data).toMatchObject({
        endsAt: at(E, 30 * SEC).toISOString(),
      });
    });

    it.each([
      ['E − 121 s', -121 * SEC],
      ['E − 120 s', -120 * SEC],
    ])('S21 AS-24: a bid at %s does not move the end', async (_n, offset) => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      await t.setTime(at(E, offset));
      const res = await bid(u1, id, 5000);
      expect(res.status).toBe(200);
      expect((await endsAtOf(id)).endsAt.toISOString()).toBe(E.toISOString());
      expect(await lastPlaced(id)).toMatchObject({ extended: false });
    });

    it('S21 AS-24: an own-maximum raise at E − 10 s does not extend', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      await t.setTime(at(E, -30 * MIN));
      await bid(u1, id, 5000);
      await t.setTime(at(E, -10 * SEC));
      const raised = await bid(u1, id, 6000);
      expect(raised.body.outcome).toBe('raised');
      expect((await endsAtOf(id)).endsAt.toISOString()).toBe(E.toISOString());
      expect(await lastPlaced(id)).toMatchObject({
        outcome: 'raised',
        extended: false,
      });
    });

    it('S21 AS-24: a rejected bid never extends', async () => {
      const { id } = await dataset();
      const [u1, u2] = await bidders(2);
      await t.setTime(at(E, -30 * MIN));
      await bid(u1, id, 5000);
      await t.setTime(at(E, -90 * SEC));
      const low = await bid(u2, id, 1400); // the minimum against a leader at 1000 is 1500
      expect(low.status).toBe(422);
      expect((await endsAtOf(id)).endsAt.toISOString()).toBe(E.toISOString());
    });
  });

  describe('the cap (AS-25)', () => {
    it('S21 AS-25: the end stops at the original end + 60 min exactly; a later bid leaves it; a bid at the capped end is closed', async () => {
      const nearCap = at(E, 59 * MIN + 30 * SEC); // already extended to 59 min 30 s
      const { id } = await dataset({ originalEndsAt: E, endsAt: nearCap });
      const [u1, u2, u3] = await bidders(3);
      await t.setTime(at(nearCap, -30 * MIN));
      await bid(u1, id, 5000);

      await t.setTime(at(nearCap, -10 * SEC));
      const capped = await bid(u2, id, 20_000);
      expect(capped.status).toBe(200);
      const cap = at(E, 60 * MIN);
      expect(capped.body.endsAt).toBe(cap.toISOString());
      expect((await endsAtOf(id)).endsAt.toISOString()).toBe(cap.toISOString());

      await t.setTime(at(cap, -5 * SEC));
      const again = await bid(u3, id, 30_000);
      expect(again.status).toBe(200);
      expect(again.body.endsAt).toBe(cap.toISOString());
      expect(await lastPlaced(id)).toMatchObject({ extended: false });

      await t.setTime(cap);
      const closed = await bid(u1, id, 40_000);
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe('auction_closed');
    });
  });

  describe('the close job follows the end (AS-26)', () => {
    it('S21 AS-26: the original job at E leaves it OPEN with no event or history, a repeat creates no second job, and E + 30 s closes it', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      await t.setTime(at(E, -90 * SEC));
      await bid(u1, id, 5000);

      const history = () =>
        rows(t.app, `SELECT 1 FROM "AuctionHistory" WHERE "auctionId" = :id`, {
          id,
        });
      const eventCount = async () => (await events(id)).length;
      const before = {
        history: (await history()).length,
        events: await eventCount(),
      };

      await t.setTime(E);
      await t.jobs.close({ auctionId: id });
      await t.jobs.close({ auctionId: id });
      expect(
        (
          await rows<{ status: string }>(
            t.app,
            `SELECT "status" FROM "Auction" WHERE "id" = :id`,
            { id },
          )
        )[0].status,
      ).toBe('OPEN');
      expect({
        history: (await history()).length,
        events: await eventCount(),
      }).toEqual(before);
      const jobs = await t.probe.find('auctions.close', { auctionId: id });
      expect(jobs).toHaveLength(1);
      expect(new Date(jobs[0].runAt).toISOString()).toBe(
        at(E, 30 * SEC).toISOString(),
      );

      await t.setTime(at(E, 30 * SEC));
      await t.jobs.close({ auctionId: id });
      const closed = await rows<{
        status: string;
        statusReason: string | null;
        winnerId: string;
      }>(
        t.app,
        `SELECT "status", "statusReason", "winnerId" FROM "Auction" WHERE "id" = :id`,
        { id },
      );
      expect(closed[0]).toEqual({
        status: 'CLOSED',
        statusReason: null,
        winnerId: u1.id,
      });
      expect((await events(id)).map((e) => e.type)).toContain('auction.closed');
    });

    it('S21 AS-26: the close job is a no-op at E + 30 s − 1 ms', async () => {
      const { id } = await dataset();
      const [u1] = await bidders(1);
      await t.setTime(at(E, -90 * SEC));
      await bid(u1, id, 5000);
      await t.setTime(at(E, 30 * SEC - 1));
      await t.jobs.close({ auctionId: id });
      expect(
        (
          await rows<{ status: string }>(
            t.app,
            `SELECT "status" FROM "Auction" WHERE "id" = :id`,
            { id },
          )
        )[0].status,
      ).toBe('OPEN');
    });
  });
});
