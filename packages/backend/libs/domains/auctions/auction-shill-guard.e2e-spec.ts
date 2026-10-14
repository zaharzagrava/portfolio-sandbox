import { randomUUID } from 'node:crypto';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { ShopAccessService } from '@app/domains/tenancy';
import type { TestUser } from '@app/test/utils/catalog-app';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import {
  createAuctionsApp,
  fastStoreOf,
  rows,
  seedAuction,
  seedSeller,
  stockOf,
  type AuctionTestApp,
  type FastStore,
} from './testing/auction-app';

const MIN = 60_000;
const T = new Date('2026-10-14T12:00:00.000Z');
const E = new Date(T.getTime() + 60 * MIN);

describe('Auctions: shill-bid guard', () => {
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

  /** DS-1 with the unit held: the product has 2 in stock, the auction holds the third. */
  const dataset = async (
    over: Partial<Parameters<typeof seedAuction>[1]> = {},
  ) => {
    const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 2 }]);
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
  const bidRows = (id: string) =>
    rows(t.app, `SELECT 1 FROM "Bid" WHERE "auctionId" = :id`, { id });
  const status = async (id: string) =>
    (
      await rows<{
        status: string;
        statusReason: string | null;
        winnerId: string | null;
        returnPending: boolean;
      }>(
        t.app,
        `SELECT "status", "statusReason", "winnerId", "returnPending" FROM "Auction" WHERE "id" = :id`,
        { id },
      )
    )[0];
  const eventTypes = async (id: string) =>
    (await outboxRowsFor(t.app, id)).map((e) => e.type);

  describe('members cannot bid (AS-40)', () => {
    it('S21 AS-40: every role of the selling shop is refused 403 shill_bid_forbidden; nothing recorded; the counter counts', async () => {
      const { s, id } = await dataset();
      const staff = await t.user();
      const admin = await t.user();
      const viewer = await t.user();
      await addMember(t.app, s.shop.id, staff.id, 'STAFF');
      await addMember(t.app, s.shop.id, admin.id, 'ADMIN');
      await addMember(t.app, s.shop.id, viewer.id, 'VIEWER');
      const before = MetricsRegistry.value('auction_shill_blocked_total') ?? 0;

      for (const member of [s.owner, staff, admin, viewer]) {
        const res = await bid(member, id, 5000);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('shill_bid_forbidden');
      }
      expect(await bidRows(id)).toEqual([]);
      expect(await eventTypes(id)).toEqual([]);
      expect(t.realtime.published).toEqual([]);
      expect(MetricsRegistry.value('auction_shill_blocked_total') ?? 0).toBe(
        before + 4,
      );
    });

    it('S21 AS-40: a non-member and a member of another shop are accepted', async () => {
      const { id } = await dataset();
      const stranger = await t.user();
      const otherShopMember = await t.user();
      await createShop(t.app, otherShopMember);
      expect((await bid(stranger, id, 5000)).status).toBe(200);
      expect((await bid(otherShopMember, id, 8000)).status).toBe(200);
      expect(await bidRows(id)).toHaveLength(2);
    });
  });

  describe('the guard fails closed (AS-41)', () => {
    it('S21 AS-41: a tenancy lookup that times out → 503 bid_unavailable with Retry-After: 2, nothing recorded', async () => {
      const { id } = await dataset();
      const u1 = await t.user();
      const restore = t.patch(
        t.app.get(ShopAccessService),
        'getRole',
        () => (() => new Promise(() => undefined)) as never,
      );
      const res = await bid(u1, id, 5000);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('bid_unavailable');
      expect(res.headers['retry-after']).toBe('2');
      expect(await bidRows(id)).toEqual([]);

      restore();
      expect((await bid(u1, id, 5000)).status).toBe(200);
    });

    it('S21 AS-41: a tenancy lookup that fails → 503 bid_unavailable, nothing recorded', async () => {
      const { id } = await dataset();
      const u1 = await t.user();
      t.patch(
        t.app.get(ShopAccessService),
        'getRole',
        () => (() => Promise.reject(new Error('tenancy down'))) as never,
      );
      const res = await bid(u1, id, 5000);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('bid_unavailable');
      expect(await bidRows(id)).toEqual([]);
    });
  });

  describe('awarding re-checks (AS-42)', () => {
    it('S21 AS-42: a leader who became a member before the close → UNSOLD(leader_ineligible), the unit returned once, no order requested', async () => {
      const { s, id } = await dataset();
      const u1 = await t.user();
      expect((await bid(u1, id, 5000)).status).toBe(200);
      await addMember(t.app, s.shop.id, u1.id, 'STAFF');

      await t.setTime(E);
      await t.jobs.close({ auctionId: id });
      await t.jobs.close({ auctionId: id });
      expect(await status(id)).toMatchObject({
        status: 'UNSOLD',
        statusReason: 'leader_ineligible',
        winnerId: null,
        returnPending: true,
      });
      const closed = (await outboxRowsFor(t.app, id)).find(
        (e) => e.type === 'auction.closed',
      )!;
      expect((closed.payload as { payload: unknown }).payload).toMatchObject({
        status: 'UNSOLD',
        reason: 'leader_ineligible',
        winnerId: null,
      });
      expect(
        await t.probe.find('auctions.request-order', { auctionId: id }),
      ).toEqual([]);

      await t.jobs.returnStock({ auctionId: id });
      await t.jobs.returnStock({ auctionId: id });
      expect(await stockOf(t.app, [s.products[0].id])).toEqual({
        [s.products[0].id]: 3,
      });
      expect(await status(id)).toMatchObject({ returnPending: false });
    });

    it('S21 AS-42: a bid that changes the leader between the check and the lock is re-evaluated: the new leader is checked, never an unchecked one awarded', async () => {
      // the extension cap is already reached, so the late bid does not move the end the close waits for
      const { s, id } = await dataset({ originalEndsAt: T });
      const [u1, u2] = [await t.user(), await t.user()];
      await bid(u1, id, 5000);
      await addMember(t.app, s.shop.id, u1.id, 'STAFF'); // the old leader is now a member

      // u2's bid is decided at E − 1 ms and held inside its decision, holding the auction lock
      await t.setTime(new Date(E.getTime() - 1));
      const gate = t.gate.arm(u2.id);
      // a supertest request only starts when it is awaited: wrap it so it is on the wire now
      const racing = Promise.resolve(bid(u2, id, 9000));
      await gate.reached;
      expect(t.gate.reached.map((r) => r.bidderId)).toContain(u2.id);

      // the close starts at E: it checks u1 (a member) outside any transaction, then waits for the lock
      await t.setTime(E);
      const closing = t.jobs.close({ auctionId: id });
      await untilBlockedOnLock();
      gate.open();
      const [placed] = await Promise.all([racing, closing]);

      expect(placed.status).toBe(200);
      expect(await status(id)).toMatchObject({
        status: 'CLOSED',
        statusReason: null,
        winnerId: u2.id, // never u1, who is a member; u2 was checked on the second pass
      });
    });
  });

  /** Waits until a statement is waiting for a row lock (the close behind the held bid), never sleeping blindly. */
  async function untilBlockedOnLock(): Promise<void> {
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
  }
});
