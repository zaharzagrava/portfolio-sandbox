import { randomUUID } from 'node:crypto';
import { addMember } from '@app/test/utils/tenancy-fixtures';
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

// Smoke of the behaviors the first auctions spec guarded (L-017), now through the HTTP surface and the jobs of the
// Postgres-first design. The full matrices live in auction-bidding, -anti-sniping, -shill-guard and -close.
const SEC = 1000;
const MIN = 60 * SEC;
const T = new Date('2026-10-14T12:00:00.000Z');
const E = new Date(T.getTime() + 60 * MIN);

describe('Auctions (e2e smoke)', () => {
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

  const dataset = async () => {
    const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 3 }]);
    const id = await seedAuction(t.app, {
      shopId: s.shop.id,
      productId: s.products[0].id,
      startsAt: T,
      endsAt: E,
    });
    return { s, id };
  };
  const bid = (user: TestUser, id: string, max: number, key?: string) =>
    t
      .as(user)
      .post(`/api/auctions/${id}/bids`)
      .set('Idempotency-Key', key ?? `bid-${randomUUID()}`)
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
  const auction = async (id: string) =>
    (
      await rows<{
        status: string;
        winnerId: string | null;
        endsAt: Date;
      }>(
        t.app,
        `SELECT "status", "winnerId", "endsAt" FROM "Auction" WHERE "id" = :id`,
        { id },
      )
    )[0];
  const bidRows = (id: string) =>
    rows<{ sequence: number }>(
      t.app,
      `SELECT "sequence" FROM "Bid" WHERE "auctionId" = :id ORDER BY "sequence"`,
      { id },
    );

  it('S21 AS-11: proxy bidding: the visible price is the second-highest maximum plus the increment, capped by the leader maximum', async () => {
    const { id } = await dataset();
    const [u1, u2] = await bidders(2);
    const a = await bid(u1, id, 10_000);
    const b = await bid(u2, id, 5000);

    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ outcome: 'leading', priceMinor: 1000 });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({
      outcome: 'outbid',
      priceMinor: 5500,
      youAreLeading: false,
    });
  });

  it('S21 AS-19: concurrent bids: the highest maximum leads at second maximum + increment, sequences gapless, nothing lost', async () => {
    const { id } = await dataset();
    const users = await bidders(5);
    const maxes = [5000, 6000, 7000, 8000, 9000];
    const results = await Promise.all(
      users.map((u, i) => Promise.resolve(bid(u, id, maxes[i]))),
    );

    // a bid that lands after a higher one may be below the new minimum: that is refused, never lost silently
    const accepted = results.flatMap((r, i) => (r.status === 200 ? [i] : []));
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('bid_too_low');
    }
    expect(results[4].status).toBe(200);
    const log = await bidRows(id);
    expect(log.map((r) => r.sequence)).toEqual(accepted.map((_, i) => i + 1));
    // the price is the highest accepted other maximum + increment
    const secondMax = Math.max(
      ...accepted.slice(0, -1).map((i) => maxes[i]),
      0,
    );
    const view = await t.as(users[0]).get(`/api/auctions/${id}`);
    expect(view.status).toBe(200);
    expect(view.body.priceMinor).toBe(
      secondMax === 0 ? 1000 : Math.min(9000, secondMax + 500),
    );
  });

  it('S21 AS-24: anti-sniping: a bid in the final 2 minutes extends the end', async () => {
    const { id } = await dataset();
    const [u1] = await bidders(1);
    await t.setTime(new Date(E.getTime() - 90 * SEC));
    const res = await bid(u1, id, 5000);

    expect(res.status).toBe(200);
    expect(res.body.endsAt).toBe(
      new Date(E.getTime() + 30 * SEC).toISOString(),
    );
    expect((await auction(id)).endsAt.getTime()).toBe(E.getTime() + 30 * SEC);
  });

  it("S21 AS-40: the selling shop's members cannot bid (shill bidding)", async () => {
    const { s, id } = await dataset();
    const staff = await t.user();
    await addMember(t.app, s.shop.id, staff.id, 'STAFF');

    for (const member of [s.owner, staff]) {
      const res = await bid(member, id, 5000);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('shill_bid_forbidden');
    }
    expect(await bidRows(id)).toEqual([]);
  });

  it('S21 AS-18: no lost or doubled bid: the same Idempotency-Key replays one row', async () => {
    const { id } = await dataset();
    const [u1] = await bidders(1);
    const key = `bid-${randomUUID()}`;
    const first = await bid(u1, id, 5000, key);
    const second = await bid(u1, id, 5000, key);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await bidRows(id)).toHaveLength(1);
  });

  it('S21 AS-27: close exactly once with the winner; AS-26: an extended auction is left OPEN by the original close job', async () => {
    const { id } = await dataset();
    const [u1] = await bidders(1);
    expect((await bid(u1, id, 5000)).status).toBe(200);

    await t.setTime(E);
    await t.jobs.close({ auctionId: id });
    await t.jobs.close({ auctionId: id });
    expect(await auction(id)).toMatchObject({
      status: 'CLOSED',
      winnerId: u1.id,
    });

    const second = await dataset();
    const [u2] = await bidders(1);
    await t.setTime(new Date(E.getTime() - 90 * SEC));
    expect((await bid(u2, second.id, 5000)).status).toBe(200);
    await t.setTime(E);
    await t.jobs.close({ auctionId: second.id });
    expect((await auction(second.id)).status).toBe('OPEN');
  });
});
