import {
  createCompetitorApp,
  T0,
  type CompetitorTestApp,
  type SeededShop,
} from './testing/competitor-fixtures';

const HOUR = 3_600_000;
const U1 = 'https://rival.test/p/iphone';

/**
 * Smoke path of the competitor crawler (registration -> crawl -> record -> alert). The detailed
 * scenarios live in the competitor-*.e2e-spec.ts files; this file keeps the end-to-end flow of the
 * former crawler spec under S41 scenario ids.
 */
describe('Competitor monitor: crawler end to end', () => {
  let t: CompetitorTestApp;
  let A: SeededShop;
  let watchId: string;
  const site = () => t.sites['rival.test'];
  const advance = (nextCheckAt: Date) =>
    t.clock.set(new Date(Math.max(t.clock.nowMs(), nextCheckAt.getTime())));

  beforeAll(async () => {
    t = await createCompetitorApp({ sites: ['rival.test', 'other.test'] });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    A = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
    const product = await t.product(A.shopId, { priceMinor: 99_900 });
    watchId = (await t.register(A.owner, A.shopId, product.id, U1)).id;
  });

  it('S41 AS-32 AS-43 AS-44: the page price is recorded and the owner is alerted only when undercut', async () => {
    site().priced('/p/iphone', '1099.00');
    await t.cycle();
    const first = (await t.target(U1))!;
    expect(first).toMatchObject({ lastStatus: 'ok', observationNo: 1 });
    expect(await t.alerts(watchId)).toHaveLength(0);

    site().priced('/p/iphone', '899.00');
    advance(first.nextCheckAt);
    await t.cycle();
    const second = (await t.target(U1))!;
    expect(second.observationNo).toBe(2);
    expect(Number(second.lastPriceMinor)).toBe(89_900);
    expect(await t.alerts(watchId)).not.toHaveLength(0);
    expect(await t.history(second.id)).toHaveLength(2);
  });

  it('S41 AS-18: a path robots.txt disallows is never fetched', async () => {
    site().robots = { body: 'User-agent: *\nDisallow: /private' };
    site().priced('/private/deal', 899);
    const product = await t.product(A.shopId);
    const u = 'https://rival.test/private/deal';
    await t.register(A.owner, A.shopId, product.id, u);

    await t.cycle();

    const paths = site()
      .requests()
      .map((r) => r.path);
    expect(paths).toContain('/robots.txt');
    expect(paths.filter((p) => p.startsWith('/private'))).toEqual([]);
    const row = (await t.target(u))!;
    expect(row.lastStatus).toBe('disallowed_by_robots');
    expect(row.observationNo).toBe(0);
    expect(row.nextCheckAt).toEqual(new Date(T0.getTime() + 24 * HOUR));
  });

  it('S41 AS-35: an unchanged page skips extraction and backs off the next check', async () => {
    site().priced('/p/iphone', '899.00');
    await t.cycle();
    advance((await t.target(U1))!.nextCheckAt);

    await t.cycle();

    const again = (await t.target(U1))!;
    expect(again).toMatchObject({
      lastStatus: 'unchanged',
      unchangedStreak: 1,
      observationNo: 1,
    });
    expect(again.nextCheckAt.getTime()).toBeGreaterThanOrEqual(
      t.clock.nowMs() + 12 * HOUR,
    );
    expect(await t.history(again.id)).toHaveLength(1);
  });

  it('S41 AS-23: many watchers of one URL share a single fetch', async () => {
    const B = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
    const product = await t.product(B.shopId);
    await t.register(B.owner, B.shopId, product.id, U1);
    site().priced('/p/iphone', '899.00');

    await t.cycle();

    expect(
      site()
        .requests()
        .filter((r) => r.path !== '/robots.txt'),
    ).toHaveLength(1);
    expect(await t.watchRows()).toHaveLength(2);
    expect((await t.target(U1))!.observationNo).toBe(1);
    expect(await t.alerts(watchId)).not.toHaveLength(0);
  });
});
