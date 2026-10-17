import { competitorPricesSchema } from '@marketplace-sandbox/contracts';
import {
  createCompetitorApp,
  T0,
  type CompetitorTestApp,
  type SeededShop,
  type TestUser,
} from './testing/competitor-fixtures';
import { productPage } from './testing/competitor-site';
import {
  OBSERVATION_HISTORY,
  type ObservationHistory,
} from './domain/crawler-ports';

const HOUR = 3_600_000;
const U1 = 'https://rival.test/p/iphone';
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

describe('Competitor monitor: price observation, change detection and failure handling', () => {
  let t: CompetitorTestApp;
  let A: SeededShop;
  let PA: { id: string };
  let watchId: string;
  const site = () => t.sites['rival.test'];

  beforeAll(async () => {
    t = await createCompetitorApp({ sites: ['rival.test', 'other.test'] });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    A = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
    PA = await t.product(A.shopId, { priceMinor: 99_900 });
    watchId = (await t.register(A.owner, A.shopId, PA.id, U1)).id;
  });

  const target = async () => (await t.target(U1))!;
  /** Moves the clock to the target's due time and crawls it. */
  const nextCrawl = async () => {
    const row = await target();
    t.clock.set(new Date(Math.max(t.clock.nowMs(), row.nextCheckAt.getTime())));
    await t.cycle();
    return target();
  };
  const pageCount = () => site().requests(new URL(U1).pathname).length;

  describe('first observation and changes', () => {
    it('S41 AS-32: the first price is recorded once, with a jittered next check, a history row and an archived page', async () => {
      t.crawl.random = Math.random;
      site().priced('/p/iphone', '899.00');

      await t.cycle();

      const row = await target();
      expect(row).toMatchObject({
        lastStatus: 'ok',
        lastPriceMinor: '89900',
        currency: 'EUR',
        observationNo: 1,
        unchangedStreak: 0,
      });
      expect(row.lastCheckedAt).toEqual(T0);
      expect(row.nextCheckAt.getTime()).toBeGreaterThanOrEqual(
        T0.getTime() + 5.4 * HOUR - 1,
      );
      expect(row.nextCheckAt.getTime()).toBeLessThanOrEqual(
        T0.getTime() + 6.6 * HOUR + 1,
      );
      expect(await t.history(row.id)).toEqual([
        {
          ts: '2026-10-06 12:00:00.000',
          price_minor: 89_900,
          currency: 'EUR',
          observation_no: 1,
        },
      ]);
      const archived = await t.archived();
      expect(archived).toHaveLength(1);
      expect(archived[0].key).toMatch(
        new RegExp(
          `^crawl/2026-10-06/rival\\.test/${row.id}-${T0.getTime()}\\.html$`,
        ),
      );
    });

    it('S41 AS-34: a one-token price change is recorded as a second observation, not as unchanged', async () => {
      site().priced('/p/iphone', '899.00');
      await t.cycle();
      site().priced('/p/iphone', '1099.00');

      const row = await nextCrawl();

      expect(row).toMatchObject({
        lastStatus: 'ok',
        lastPriceMinor: '109900',
        observationNo: 2,
      });
      expect((await t.history(row.id)).map((r) => r.price_minor)).toEqual([
        89_900, 109_900,
      ]);
    });

    it('S41 AS-35: an unchanged page backs off 12, 24, 48, 48 hours with no history and no archive, and a changed price resets the ladder', async () => {
      site().priced('/p/iphone', '899.00');
      await t.cycle();

      for (const [streak, hours] of [
        [1, 12],
        [2, 24],
        [3, 48],
        [4, 48],
      ] as const) {
        const row = await nextCrawl();
        expect(row).toMatchObject({
          lastStatus: 'unchanged',
          unchangedStreak: streak,
          observationNo: 1,
        });
        expect(row.nextCheckAt).toEqual(
          new Date(t.clock.nowMs() + hours * HOUR),
        );
      }
      expect(await t.history((await target()).id)).toHaveLength(1);
      expect(await t.archived()).toHaveLength(1);

      site().priced('/p/iphone', '849.00');
      const changed = await nextCrawl();
      expect(changed).toMatchObject({
        lastStatus: 'ok',
        unchangedStreak: 0,
        observationNo: 2,
      });
      expect(changed.nextCheckAt).toEqual(new Date(t.clock.nowMs() + 6 * HOUR));
    });

    it('S41 AS-35: every interval carries at most 10 % jitter and is never below an hour', async () => {
      t.crawl.random = Math.random;
      site().priced('/p/iphone', '899.00');
      await t.cycle();
      const seen = new Set<number>();
      for (let i = 0; i < 4; i++) {
        const row = await nextCrawl();
        const ratio = (row.nextCheckAt.getTime() - t.clock.nowMs()) / HOUR;
        seen.add(Math.round(ratio * 100));
        const base = [12, 24, 48, 48][i];
        expect(ratio).toBeGreaterThanOrEqual(base * 0.9 - 1e-9);
        expect(ratio).toBeLessThanOrEqual(base * 1.1 + 1e-9);
        expect(ratio).toBeGreaterThanOrEqual(1);
      }
      expect(seen.size).toBeGreaterThan(1);
    });

    it('S41 AS-37: a changed page with the same price is archived and restarts the ladder without a history row', async () => {
      site().priced('/p/iphone', '899.00');
      await t.cycle();
      await nextCrawl(); // unchanged, streak 1
      site().priced('/p/iphone', '899.00', 'EUR', {
        widget:
          'A completely different promotion for winter coats and boots '.repeat(
            20,
          ),
      });

      const row = await nextCrawl();

      expect(row).toMatchObject({
        lastStatus: 'ok',
        unchangedStreak: 0,
        observationNo: 1,
        lastPriceMinor: '89900',
      });
      expect(row.nextCheckAt).toEqual(new Date(t.clock.nowMs() + 6 * HOUR));
      expect(await t.archived()).toHaveLength(2);
      expect(await t.history(row.id)).toHaveLength(1);
    });

    it.each([
      [
        'no price',
        'no_price',
        () => '<html><body>' + 'Sold by us. '.repeat(60) + '</body></html>',
      ],
      [
        'only out-of-stock offers',
        'out_of_stock',
        () =>
          productPage('899.00', 'EUR', {
            availability: 'https://schema.org/OutOfStock',
            widget:
              'Currently unavailable, notify me when it is back in stock '.repeat(
                60,
              ),
          }),
      ],
    ])(
      'S41 AS-38: a page with %s keeps the last price, writes no row or event, archives once per fingerprint change and slows after three',
      async (_name, status, page) => {
        site().priced('/p/iphone', '899.00');
        await t.cycle();
        await t.alerts(watchId).then((rows) => expect(rows).toHaveLength(1));
        site().page('/p/iphone', { body: page });

        const first = await nextCrawl();
        expect(first).toMatchObject({
          lastStatus: status,
          lastPriceMinor: '89900',
          observationNo: 1,
          noPriceStreak: 1,
        });
        expect(first.nextCheckAt).toEqual(new Date(t.clock.nowMs() + 6 * HOUR));
        const archivedAfterFirst = (await t.archived()).length;
        expect(archivedAfterFirst).toBe(2);

        await nextCrawl();
        const third = await nextCrawl();
        expect(third.noPriceStreak).toBe(3);
        expect(third.nextCheckAt).toEqual(
          new Date(t.clock.nowMs() + 24 * HOUR),
        );
        expect((await t.archived()).length).toBe(2);
        expect(await t.history(third.id)).toHaveLength(1);
        expect(await t.alerts(watchId)).toHaveLength(1);

        site().priced('/p/iphone', '829.00');
        const back = await nextCrawl();
        expect(back).toMatchObject({
          lastStatus: 'ok',
          lastPriceMinor: '82900',
          observationNo: 2,
          noPriceStreak: 0,
        });
      },
    );

    it('S41 AS-39: a currency change is a new observation and the history reads within the latest currency', async () => {
      site().priced('/p/iphone', '899.00', 'EUR');
      await t.cycle();
      site().priced('/p/iphone', '949.00', 'USD');

      const row = await nextCrawl();

      expect(row).toMatchObject({
        lastPriceMinor: '94900',
        currency: 'USD',
        observationNo: 2,
        lastStatus: 'ok',
      });
      const owner = await t.reauth(A.owner);
      const prices = competitorPricesSchema.parse(
        (
          await t
            .as(owner)
            .get(`/api/shops/${A.shopId}/competitors/${watchId}/prices?days=30`)
            .expect(200)
        ).body,
      );
      expect(prices).toMatchObject({
        currency: 'USD',
        lowestMinor: 94_900,
        latestMinor: 94_900,
      });
      expect(prices.points.map((p) => p.priceMinor)).toEqual([94_900]);
    });
  });

  describe('failing stores', () => {
    it('S41 AS-41: with the history store down nothing advances and the crawl retries in 15 minutes; on recovery the observation is recorded once', async () => {
      site().priced('/p/iphone', '899.00');
      t.faults.history = true;

      await t.cycle();

      const down = await target();
      expect(down).toMatchObject({
        lastStatus: 'history_unavailable',
        lastPriceMinor: null,
        observationNo: 0,
      });
      expect(down.nextCheckAt).toEqual(at(15 * 60_000));
      expect(await t.archived()).toHaveLength(0);
      expect(await t.alerts(watchId)).toHaveLength(0);

      t.faults.history = false;
      const back = await nextCrawl();
      expect(back).toMatchObject({
        lastStatus: 'ok',
        lastPriceMinor: '89900',
        observationNo: 1,
      });
      expect(await t.history(back.id)).toHaveLength(1);
    });

    it('S41 AS-41: a retried history write with the same counter adds no second row', async () => {
      site().priced('/p/iphone', '899.00');
      await t.cycle();
      const row = await target();
      const history = t.app.get<ObservationHistory>(OBSERVATION_HISTORY, {
        strict: false,
      });

      for (let i = 0; i < 3; i++)
        await history.append({
          targetId: row.id,
          observationNo: 1,
          observedAt: T0,
          priceMinor: 89_900,
          currency: 'EUR',
        });

      expect(await t.history(row.id)).toHaveLength(1);
    });

    it('S41 AS-41: with object storage down the observation is kept, the archive is skipped and counted, and a warning is logged', async () => {
      site().priced('/p/iphone', '899.00');
      t.faults.archive = true;
      const before = t.metrics.archiveFailed();

      await t.cycle();

      const row = await target();
      expect(row).toMatchObject({
        lastStatus: 'ok',
        lastPriceMinor: '89900',
        observationNo: 1,
      });
      expect(await t.archived()).toHaveLength(0);
      expect(t.metrics.archiveFailed()).toBe(before + 1);
      const warn = t.logs().find((l) => l.line.event === 'archive_failed');
      expect(warn?.level).toBe('warn');
      expect(warn?.line).toMatchObject({
        targetId: row.id,
        host: 'rival.test',
      });
    });
  });

  describe('two workers on one target', () => {
    it('S41 AS-42: two crawls that both found a new price record one observation, one history row and one event per owner', async () => {
      const olga: TestUser = await t.owner(A.shopId);
      void olga;
      site().priced('/p/iphone', '899.00', 'EUR', { widget: 'x' });
      // an expired lease let two workers fetch the same target
      const id = (await target()).id;

      const outcomes = await Promise.all([
        t.crawl.crawl(id),
        t.crawl.crawl(id),
      ]);

      const row = await target();
      expect(row).toMatchObject({ observationNo: 1, lastPriceMinor: '89900' });
      expect(outcomes.map((o) => o.status).sort()).toEqual(
        [null, 'ok'].sort((a, b) => String(a).localeCompare(String(b))),
      );
      expect(await t.history(row.id)).toHaveLength(1);
      const alerts = await t.alerts(watchId);
      expect(alerts).toHaveLength(2);
      expect(
        new Set(
          alerts.map(
            (a) =>
              (a.payload as { payload: { ownerId: string } }).payload.ownerId,
          ),
        ).size,
      ).toBe(2);
    });
  });
});
