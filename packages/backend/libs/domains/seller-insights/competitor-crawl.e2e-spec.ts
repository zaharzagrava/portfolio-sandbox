import {
  createCompetitorApp,
  T0,
  type CompetitorTestApp,
  type SeededShop,
  type SiteHost,
} from './testing/competitor-fixtures';
import { productPage, type PageSpec } from './testing/competitor-site';
import { CompetitorShopProjector } from './infra/projectors/competitor.projectors';

const HOUR = 3_600_000;
const url = (host: SiteHost, path: string) => `https://${host}${path}`;
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('Competitor monitor: polite and SSRF-safe crawling (frontier, robots, limits)', () => {
  let t: CompetitorTestApp;
  let A: SeededShop;

  beforeAll(async () => {
    t = await createCompetitorApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    A = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
  });

  /** A watch of shop A (or `shop`) on a fresh product of that shop. */
  const watchOn = async (u: string, shop: SeededShop = A) => {
    const product = await t.product(shop.shopId);
    return t.register(shop.owner, shop.shopId, product.id, u);
  };
  const target = async (u: string) => (await t.target(u))!;
  const pageRequests = (host: SiteHost) =>
    t.sites[host].requests().filter((r) => r.path !== '/robots.txt');
  const robotsRequests = (host: SiteHost) =>
    t.sites[host].requests('/robots.txt');
  const listOf = (host: string) =>
    t.redis.lrange(`crawl:{s}:host:${host}`, 0, -1);

  describe('scheduling and the frontier', () => {
    it('S41 AS-16: each due target is queued once per cycle, a stale mark is replaced, and a cap takes the highest plans first', async () => {
      const pro = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
      const ent = await t.seedShop({
        plan: 'ENTERPRISE',
        limit: 100,
        announce: true,
      });
      const starters = await Promise.all(
        [1, 2, 3, 4].map(() =>
          t.seedShop({ plan: 'STARTER', limit: 100, announce: true }),
        ),
      );
      const [T1, T2, T3, T4] = ['/p/1', '/p/2', '/p/3']
        .map((p) => url('rival.test', p))
        .concat(url('other.test', '/p/4'));
      await watchOn(T1, pro);
      await watchOn(T2, starters[0]);
      await watchOn(T2, starters[1]);
      await watchOn(T2, starters[2]);
      await watchOn(T3, ent);
      await watchOn(T3, starters[0]);
      await watchOn(T4, starters[3]);
      const ids = Object.fromEntries(
        await Promise.all(
          [T1, T2, T3, T4].map(
            async (u, i) => [`T${i + 1}`, (await target(u)).id] as const,
          ),
        ),
      );
      // earlier due time breaks ties between targets of the same plan
      await t.pg(
        `UPDATE "CrawlTarget" SET "nextCheckAt" = :at WHERE "id" = :id`,
        { at: at(-2 * HOUR), id: ids.T2 },
      );
      await t.pg(
        `UPDATE "CrawlTarget" SET "nextCheckAt" = :at WHERE "id" = :id`,
        { at: at(-HOUR), id: ids.T4 },
      );

      expect(await t.schedule()).toBe(4);
      expect(await t.schedule()).toBe(0);
      expect((await listOf('rival.test')).sort()).toEqual(
        [ids.T1, ids.T2, ids.T3].sort(),
      );
      expect(await listOf('other.test')).toEqual([ids.T4]);

      t.advance(16 * 60_000);
      expect(await t.schedule()).toBe(4);

      for (const entry of await t.keys('crawl:*')) await t.redis.del(entry.key);
      expect(await t.schedule(2)).toBe(2);
      expect(
        [
          ...(await listOf('rival.test')),
          ...(await listOf('other.test')),
        ].sort(),
      ).toEqual([ids.T3, ids.T1].sort());
      for (const entry of await t.keys('crawl:*')) await t.redis.del(entry.key);
      await t.schedule(3);
      expect(
        [
          ...(await listOf('rival.test')),
          ...(await listOf('other.test')),
        ].sort(),
      ).toEqual([ids.T3, ids.T1, ids.T2].sort());
    });

    it('S41 AS-16: a retired target and the target of a paused watch are never queued', async () => {
      const gone = await t.seedShop({ limit: 100, announce: true });
      const paused = await t.seedShop({ limit: 100, announce: true });
      const w1 = await watchOn(url('rival.test', '/p/1'), gone);
      await watchOn(url('rival.test', '/p/2'), paused);
      await watchOn(url('rival.test', '/p/3'));
      await t
        .as(gone.owner)
        .delete(`/api/shops/${gone.shopId}/competitors/${w1.id}`)
        .expect(204);
      await t.deliver(t.projector(CompetitorShopProjector), [
        t.shopStatusChanged({
          shopId: paused.shopId,
          to: 'SUSPENDED',
          shopVersion: 2,
        }),
      ]);

      expect(await t.schedule()).toBe(1);
      expect(await listOf('rival.test')).toEqual([
        (await target(url('rival.test', '/p/3'))).id,
      ]);
    });

    it('S41 AS-17: with the fast store emptied the next cycle queues every due target and the crawl continues', async () => {
      t.sites['rival.test'].priced('/p/1', 899).priced('/p/2', 799);
      await watchOn(url('rival.test', '/p/1'));
      await watchOn(url('rival.test', '/p/2'));
      expect(await t.schedule()).toBe(2);

      for (const entry of await t.keys('crawl:*')) await t.redis.del(entry.key);
      expect(await t.keys('crawl:*')).toEqual([]);
      expect(await t.schedule()).toBe(2);
      await t.drain();

      expect(
        pageRequests('rival.test')
          .map((r) => r.path)
          .sort(),
      ).toEqual(['/p/1', '/p/2']);
      expect((await target(url('rival.test', '/p/1'))).observationNo).toBe(1);
    });

    it('S41 AS-17: a worker that died holding a lease frees the host after the lease and the target is crawled again within 15 minutes of its due time', async () => {
      t.sites['rival.test'].priced('/p/1', 899);
      await watchOn(url('rival.test', '/p/1'));
      await t.schedule();
      // the worker takes the target and dies: the host stays leased, nothing is released
      const taken = await t.frontier.take();
      expect(taken?.host).toBe('rival.test');
      expect(await t.frontier.take()).toBeNull();
      expect(pageRequests('rival.test')).toHaveLength(0);

      t.skipGaps(); // the 60 s lease has passed
      t.advance(16 * 60_000); // and the queue mark with it
      expect(await t.schedule()).toBe(1);
      await t.drain();

      expect(pageRequests('rival.test')).toHaveLength(1);
      expect((await target(url('rival.test', '/p/1'))).lastStatus).toBe('ok');
    });
  });

  describe('robots.txt', () => {
    it('S41 AS-18: a disallowed path is never requested; the target is checked again in 24 hours', async () => {
      t.sites['rival.test'].robots = {
        body: 'User-agent: *\nDisallow: /private',
      };
      t.sites['rival.test'].priced('/private/deal', 899);
      const u = url('rival.test', '/private/deal');
      await watchOn(u);

      await t.cycle();

      expect(t.sites['rival.test'].requests().map((r) => r.path)).toEqual([
        '/robots.txt',
      ]);
      const row = await target(u);
      expect(row).toMatchObject({
        lastStatus: 'disallowed_by_robots',
        observationNo: 0,
        lastPriceMinor: null,
      });
      expect(row.nextCheckAt).toEqual(at(24 * HOUR));
      expect(await t.archived()).toHaveLength(0);
      expect(
        await t
          .watchRows()
          .then((w) => w.map((x) => x.id))
          .then((ids) => Promise.all(ids.map((id) => t.outbox(id)))),
      ).toEqual([[]]);
    });

    it.each([
      [
        '200 with rules',
        { status: 200, body: 'User-agent: *\nDisallow: /secret' },
        true,
        'rules',
        24 * HOUR,
      ],
      ['404', { status: 404, body: 'nope' }, true, 'allow_all', HOUR],
      ['410', { status: 410, body: 'gone' }, true, 'allow_all', HOUR],
      ['403', { status: 403, body: 'no' }, true, 'allow_all', HOUR],
      ['500', { status: 500, body: 'boom' }, false, 'unavailable', 15 * 60_000],
      [
        '503',
        { status: 503, body: 'later' },
        false,
        'unavailable',
        15 * 60_000,
      ],
      [
        'a connection reset',
        { reset: true },
        false,
        'unavailable',
        15 * 60_000,
      ],
      [
        'a redirect to another origin',
        { status: 301, headers: { location: 'https://other.test/robots.txt' } },
        false,
        'unavailable',
        15 * 60_000,
      ],
    ])(
      'S41 AS-20: robots.txt answering %s',
      async (_name, robots, pageFetched, outcome, ttlMs) => {
        t.sites['rival.test'].robots = robots;
        t.sites['rival.test'].priced('/p/1', 899);
        const u = url('rival.test', '/p/1');
        await watchOn(u);

        await t.cycle();

        expect(pageRequests('rival.test')).toHaveLength(pageFetched ? 1 : 0);
        expect(t.sites['other.test'].requests()).toHaveLength(0);
        const row = await target(u);
        if (!pageFetched) {
          expect(row.lastStatus).toBe('robots_unavailable');
          expect(row.nextCheckAt).toEqual(at(HOUR));
        } else expect(row.lastStatus).toBe('ok');
        const [cache] = await t.keys('crawl:robots:*');
        expect(cache.key).toBe('crawl:robots:https://rival.test:443');
        expect(cache.ttlMs).toBeGreaterThan(ttlMs - 60_000);
        expect(cache.ttlMs).toBeLessThanOrEqual(ttlMs);
        expect(JSON.parse((await t.redis.get(cache.key))!).outcome).toBe(
          outcome,
        );
      },
    );

    it('S41 AS-20: a robots.txt slower than the deadline makes the page wait an hour', async () => {
      t.sites['rival.test'].robots = {
        body: 'User-agent: *\nAllow: /',
        delayMs: 11_000,
      };
      t.sites['rival.test'].priced('/p/1', 899);
      const u = url('rival.test', '/p/1');
      await watchOn(u);

      await t.cycle();

      expect(pageRequests('rival.test')).toHaveLength(0);
      expect((await target(u)).lastStatus).toBe('robots_unavailable');
    }, 90_000);

    it('S41 AS-21: two crawls within 24 hours request robots.txt once; after 24 hours it is requested again and a changed rule takes effect', async () => {
      t.sites['rival.test'].robots = { body: 'User-agent: *\nAllow: /' };
      t.sites['rival.test'].priced('/p/1', 899).priced('/p/2', 799);
      const [u1, u2] = [url('rival.test', '/p/1'), url('rival.test', '/p/2')];
      await watchOn(u1);
      await watchOn(u2);

      await t.cycle();
      expect(robotsRequests('rival.test')).toHaveLength(1);
      expect(pageRequests('rival.test')).toHaveLength(2);
      expect((await t.keys('crawl:robots:*')).map((k) => k.key)).toEqual([
        'crawl:robots:https://rival.test:443',
      ]);

      t.sites['rival.test'].robots = { body: 'User-agent: *\nDisallow: /' };
      t.advance(23 * HOUR);
      await t.pg(`UPDATE "CrawlTarget" SET "nextCheckAt" = :at`, {
        at: t.clock.now(),
      });
      await t.cycle();
      expect(robotsRequests('rival.test')).toHaveLength(1);

      t.advance(2 * HOUR);
      await t.pg(`UPDATE "CrawlTarget" SET "nextCheckAt" = :at`, {
        at: t.clock.now(),
      });
      await t.cycle();
      expect(robotsRequests('rival.test')).toHaveLength(2);
      expect((await target(u1)).lastStatus).toBe('disallowed_by_robots');
    });
  });

  describe('client identity', () => {
    it('S41 AS-25: page and robots requests are GET with the crawler user agent, an HTML Accept, identity encoding and nothing that identifies a shop or user', async () => {
      t.sites['rival.test'].robots = { body: 'User-agent: *\nAllow: /' };
      t.sites['rival.test'].priced('/p/1', 899);
      await watchOn(url('rival.test', '/p/1'));

      await t.cycle();

      const requests = t.sites['rival.test'].requests();
      expect(requests.map((r) => r.path)).toEqual(['/robots.txt', '/p/1']);
      for (const request of requests) {
        expect(request.method).toBe('GET');
        expect(request.headers['user-agent']).toBe(
          'MarketplacePriceBot/1.0 (+https://marketplace.dev/bot)',
        );
        expect(request.headers.accept).toContain('text/html');
        expect(request.headers['accept-encoding']).toBe('identity');
        for (const name of ['cookie', 'referer', 'authorization'])
          expect(request.headers[name]).toBeUndefined();
        const extra = Object.keys(request.headers).filter(
          (h) =>
            ![
              'host',
              'user-agent',
              'accept',
              'accept-encoding',
              'connection',
            ].includes(h),
        );
        expect(extra).toEqual([]);
      }
    });
  });

  describe('SSRF at crawl time', () => {
    it('S41 AS-26: a host that later resolves to a private address is refused with no request; IPv6 and mapped addresses alike', async () => {
      t.sites['rival.test'].priced('/p/1', 899);
      const u = url('rival.test', '/p/1');
      await watchOn(u);
      const connections = t.sites['rival.test'].connections;
      for (const address of [
        '127.0.0.1',
        '::1',
        '::ffff:10.0.0.1',
        'fd00::1',
        '169.254.169.254',
      ]) {
        t.net.set('rival.test', address);
        await t.pg(
          `UPDATE "CrawlTarget" SET "nextCheckAt" = :at, "lastStatus" = NULL`,
          { at: t.clock.now() },
        );
        await t.cycle();

        const row = await target(u);
        expect(row.lastStatus).toBe('blocked_address');
        expect(row.nextCheckAt).toEqual(
          new Date(t.clock.now().getTime() + 24 * HOUR),
        );
        t.advance(1_000);
      }
      expect(t.sites['rival.test'].connections).toBe(connections);
    });

    it('S41 AS-26: the connection goes to the address that was checked, not to a later answer of the resolver', async () => {
      t.sites['rival.test'].priced('/p/1', 899);
      const u = url('rival.test', '/p/1');
      await watchOn(u);
      t.net.lookups = [];
      // robots.txt and the page each resolve once; any further lookup would answer a loopback address
      t.net.flipAfter('rival.test', 2, '127.0.0.1');

      await t.cycle();

      expect(t.net.lookups.filter((h) => h === 'rival.test')).toHaveLength(2);
      expect(pageRequests('rival.test')).toHaveLength(1);
      expect((await target(u)).lastStatus).toBe('ok');
    });
  });

  describe('redirects', () => {
    const redirect = (status: number, location?: string): PageSpec => ({
      status,
      headers: location ? { location } : {},
      body: '',
    });

    it('S41 AS-27: a same-host redirect is followed and its final URL does not become a target', async () => {
      t.sites['rival.test']
        .page('/r1', redirect(301, '/final'))
        .priced('/final', 899);
      await watchOn(url('rival.test', '/r1'));

      await t.cycle();

      expect((await target(url('rival.test', '/r1'))).lastStatus).toBe('ok');
      expect(await t.pg(`SELECT "url" FROM "CrawlTarget"`)).toHaveLength(1);
    });

    it.each([
      [
        'a redirect to the metadata address',
        redirect(302, 'https://169.254.169.254/'),
        'blocked_address',
      ],
      [
        'a redirect to http',
        redirect(302, 'http://rival.test/x'),
        'redirect_refused',
      ],
      [
        'a redirect to another host',
        redirect(302, 'https://other.test/x'),
        'redirected_host',
      ],
      ['a redirect without Location', redirect(301), 'http_3xx'],
    ])('S41 AS-27: %s ends the crawl as %s', async (_name, spec, status) => {
      t.sites['rival.test'].page('/r', spec);
      t.sites['other.test'].priced('/x', 1);
      const u = url('rival.test', '/r');
      await watchOn(u);

      await t.cycle();

      expect((await target(u)).lastStatus).toBe(status);
      expect(t.sites['other.test'].requests()).toHaveLength(0);
    });

    it('S41 AS-27: four chained same-host redirects are too many', async () => {
      t.sites['rival.test']
        .page('/c1', redirect(301, '/c2'))
        .page('/c2', redirect(301, '/c3'))
        .page('/c3', redirect(301, '/c4'))
        .page('/c4', redirect(301, '/final'))
        .priced('/final', 899);
      const u = url('rival.test', '/c1');
      await watchOn(u);

      await t.cycle();

      expect((await target(u)).lastStatus).toBe('too_many_redirects');
      expect(pageRequests('rival.test').map((r) => r.path)).toEqual([
        '/c1',
        '/c2',
        '/c3',
        '/c4',
      ]);
    });
  });

  describe('status mapping', () => {
    const known = async (u: string) => {
      await t.pg(
        `UPDATE "CrawlTarget" SET "lastPriceMinor" = 89900, "currency" = 'EUR', "observationNo" = 1, "evaluatedNo" = 1 WHERE "url" = :u`,
        { u },
      );
    };
    const untouched = async (u: string) => {
      const row = await target(u);
      expect(row.lastPriceMinor).toBe('89900');
      expect(row.observationNo).toBe(1);
      const watches = await t.watchRows();
      for (const w of watches) expect(await t.outbox(w.id)).toEqual([]);
    };

    it.each([
      [404, 'gone', [12, 24, 48, 48]],
      [410, 'gone', [12, 24, 48, 48]],
      [401, 'blocked_by_site', [24, 24]],
      [403, 'blocked_by_site', [24, 24]],
      [400, 'http_4xx', [12, 12]],
      [418, 'http_4xx', [12, 12]],
      [500, 'http_5xx', [1, 2, 4, 8]],
      [502, 'http_5xx', [1, 2]],
      [504, 'http_5xx', [1, 2]],
    ])(
      'S41 AS-29: HTTP %i is %s with the interval ladder %j',
      async (code, status, hours) => {
        t.sites['rival.test'].page('/p/1', { status: code, body: 'x' });
        const u = url('rival.test', '/p/1');
        await watchOn(u);
        await known(u);

        for (const h of hours) {
          await t.pg(
            `UPDATE "CrawlTarget" SET "nextCheckAt" = :at WHERE "url" = :u`,
            { at: t.clock.now(), u },
          );
          await t.cycle();
          const row = await target(u);
          expect(row.lastStatus).toBe(status);
          expect(row.nextCheckAt).toEqual(
            new Date(t.clock.now().getTime() + h * HOUR),
          );
          t.advance(1_000);
        }
        await untouched(u);
      },
    );

    it('S41 AS-29: a reset connection and a failed name lookup walk the 1 hour ladder', async () => {
      t.sites['rival.test'].page('/p/1', { reset: true });
      const u = url('rival.test', '/p/1');
      await watchOn(u);
      await known(u);

      await t.cycle();
      let row = await target(u);
      expect(row.lastStatus).toBe('network_error');
      expect(row.nextCheckAt).toEqual(at(HOUR));

      t.net.unset('rival.test');
      t.advance(2 * HOUR);
      await t.cycle();
      row = await target(u);
      expect(row.lastStatus).toBe('unresolvable');
      expect(row.nextCheckAt).toEqual(
        new Date(t.clock.now().getTime() + 2 * HOUR),
      );
      await untouched(u);
    });
  });

  describe('seen-set', () => {
    it('S41 AS-31: a new URL is definitely new, a repeat is confirmed by the table, a forced false positive still creates and crawls the target, and a lost set changes nothing', async () => {
      const m = t.metrics;
      const before = {
        fresh: m.seenSet('definitely_new'),
        hit: m.seenSet('confirmed_hit'),
        fp: m.seenSet('false_positive'),
      };
      t.sites['rival.test'].priced('/p/1', 899).priced('/p/2', 799);
      const product = await t.product(A.shopId);

      const created = await t.register(
        A.owner,
        A.shopId,
        product.id,
        url('rival.test', '/p/1'),
      );
      expect(created.created).toBe(true);
      expect(m.seenSet('definitely_new')).toBe(before.fresh + 1);
      const replay = await t.register(
        A.owner,
        A.shopId,
        product.id,
        url('rival.test', '/p/1'),
      );
      expect(replay).toMatchObject({ created: false, id: created.id });
      expect(m.seenSet('confirmed_hit')).toBe(before.hit + 1);

      // every lookup now answers "probably seen"
      await t.redis.set('crawl:seen', Buffer.alloc(13_000_000, 0xff));
      const other = await t.register(
        A.owner,
        A.shopId,
        product.id,
        url('rival.test', '/p/2'),
      );
      expect(other.created).toBe(true);
      expect(m.seenSet('false_positive')).toBe(before.fp + 1);

      // the set is lost: the table still answers
      await t.redis.del('crawl:seen');
      const again = await t.register(
        A.owner,
        A.shopId,
        product.id,
        url('rival.test', '/p/2'),
      );
      expect(again).toMatchObject({ created: false, id: other.id });
      expect(m.seenSet('definitely_new')).toBe(before.fresh + 2);
      expect(await t.redis.exists('crawl:seen')).toBe(1);

      await t.cycle();
      expect(
        pageRequests('rival.test')
          .map((r) => r.path)
          .sort(),
      ).toEqual(['/p/1', '/p/2']);
    });
  });

  describe('politeness', () => {
    const gapKey = 'crawl:{s}:gap:rival.test';
    const gapMs = async () => Number(await t.redis.get(gapKey)) - t.wallNow();
    const crawlOne = async (setup: () => void) => {
      setup();
      const u = url('rival.test', '/p/1');
      await watchOn(u);
      await t.cycle({ skipGaps: false });
      return u;
    };

    it('S41 AS-22: the second request reaches the site at least Crawl-delay after the first finished, and at least a second without one', async () => {
      t.crawl.sleep = realSleep;
      t.sites['rival.test'].robots = { body: 'User-agent: *\nCrawl-delay: 2' };
      t.sites['rival.test'].priced('/p/1', 899).priced('/p/2', 799);
      await watchOn(url('rival.test', '/p/1'));
      await watchOn(url('rival.test', '/p/2'));
      await t.schedule();
      await t.drain({ skipGaps: false });

      const [robots, first, second] = t.sites['rival.test'].requests();
      expect(robots.path).toBe('/robots.txt');
      expect(first.startedAt - robots.endedAt!).toBeGreaterThanOrEqual(1_950);
      expect(second.startedAt - first.endedAt!).toBeGreaterThanOrEqual(1_950);

      await t.reset();
      t.crawl.sleep = realSleep;
      A = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
      t.sites['rival.test'].priced('/p/1', 899).priced('/p/2', 799);
      await watchOn(url('rival.test', '/p/1'));
      await watchOn(url('rival.test', '/p/2'));
      await t.schedule();
      await t.drain({ skipGaps: false });
      const [a, b] = pageRequests('rival.test');
      expect(b.startedAt - a.endedAt!).toBeGreaterThanOrEqual(950);
      expect(b.startedAt - a.endedAt!).toBeLessThan(1_950);
    }, 60_000);

    it.each([
      ['86400', 300_000],
      ['-5', 1_000],
      ['soon', 1_000],
    ])(
      'S41 AS-22: Crawl-delay %s leaves the host alone for %i ms',
      async (value, expected) => {
        await crawlOne(() => {
          t.sites['rival.test'].robots = {
            body: `User-agent: *\nCrawl-delay: ${value}`,
          };
          t.sites['rival.test'].priced('/p/1', 899);
        });

        const left = await gapMs();
        expect(left).toBeGreaterThan(expected - 5_000);
        expect(left).toBeLessThanOrEqual(expected);
      },
    );

    it.each([
      ['429', { status: 429, body: 'slow down' }, 'http_429', 10_000],
      ['503', { status: 503, body: 'later' }, 'http_503', 10_000],
      [
        '429 with Retry-After 120',
        { status: 429, headers: { 'retry-after': '120' }, body: '' },
        'http_429',
        120_000,
      ],
      [
        '429 with Retry-After 99999',
        { status: 429, headers: { 'retry-after': '99999' }, body: '' },
        'http_429',
        3_600_000,
      ],
    ])(
      'S41 AS-24: %s backs the host off and leaves price and counter alone',
      async (_name, spec, status, wait) => {
        const u = url('rival.test', '/p/1');
        t.sites['rival.test'].page('/p/1', spec);
        await watchOn(u);
        await t.pg(
          `UPDATE "CrawlTarget" SET "lastPriceMinor" = 89900, "currency" = 'EUR', "observationNo" = 1, "evaluatedNo" = 1`,
        );
        await t.schedule();
        t.skipGaps();
        await t.frontier.take().then(async (taken) => {
          await t.crawl
            .crawl(taken!.targetId)
            .then((outcome) =>
              t.frontier.release(taken!.host, outcome.delayMs),
            );
        });

        const left = await gapMs();
        expect(left).toBeGreaterThan(wait - 5_000);
        expect(left).toBeLessThanOrEqual(wait);
        const row = await target(u);
        expect(row).toMatchObject({
          lastStatus: status,
          lastPriceMinor: '89900',
          observationNo: 1,
        });
        expect(row.nextCheckAt).toEqual(at(6 * HOUR));
      },
    );
  });

  describe('a fleet of workers', () => {
    it('S41 AS-23: two instances with 16 loops each never put two requests on a host at once and serve different hosts in parallel', async () => {
      t.crawl.sleep = realSleep;
      const slow = { delayMs: 300 };
      const hosts: SiteHost[] = ['a.test', 'b.test', 'c.test'];
      const urls: string[] = [];
      for (let i = 1; i <= 10; i++) {
        t.sites['rival.test'].page(`/p/${i}`, {
          ...slow,
          body: () => '<html>' + 'x'.repeat(50) + `${i}</html>`,
        });
        urls.push(url('rival.test', `/p/${i}`));
      }
      for (const host of hosts)
        for (let i = 1; i <= 3; i++) {
          t.sites[host].page(`/p/${i}`, { ...slow, body: '<html>page</html>' });
          urls.push(url(host, `/p/${i}`));
        }
      for (const u of urls) await watchOn(u);
      await t.schedule();

      const second = t.extraWorker(16);
      t.worker.start();
      second.start();
      const deadline = Date.now() + 50_000;
      for (;;) {
        const [{ n }] = await t.pg<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM "CrawlTarget" WHERE "lastCheckedAt" IS NOT NULL`,
        );
        if (n === 19 || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await Promise.all([t.worker.stop(), second.stop()]);

      const rival = pageRequests('rival.test');
      expect(rival).toHaveLength(10);
      expect(t.sites['rival.test'].maxInFlight).toBe(1);
      const sorted = [...t.sites['rival.test'].requests()].sort(
        (x, y) => x.startedAt - y.startedAt,
      );
      for (let i = 1; i < sorted.length; i++)
        expect(
          sorted[i].startedAt - sorted[i - 1].endedAt!,
        ).toBeGreaterThanOrEqual(950);
      for (const host of hosts) {
        expect(t.sites[host].maxInFlight).toBe(1);
        expect(pageRequests(host)).toHaveLength(3);
      }
      const everything = Object.values(t.sites).flatMap((s) => s.requests());
      const edges = everything
        .flatMap(
          (r) =>
            [
              [r.startedAt, 1],
              [r.endedAt!, -1],
            ] as const,
        )
        .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      let open = 0;
      let peak = 0;
      for (const [, delta] of edges) peak = Math.max(peak, (open += delta));
      expect(peak).toBeGreaterThanOrEqual(3);
      const done = await t.pg<{ url: string }>(
        `SELECT "url" FROM "CrawlTarget" WHERE "lastCheckedAt" IS NOT NULL`,
      );
      expect(done).toHaveLength(19);
    }, 90_000);
  });

  describe('fetch limits', () => {
    const MiB = 1024 * 1024;

    it('S41 AS-28: a 5 MiB page is cut at 2 MiB, its prefix is processed and truncated is counted', async () => {
      t.sites['rival.test'].page('/p/1', {
        body: () => productPageOf(899) + ' '.repeat(5 * MiB),
      });
      const u = url('rival.test', '/p/1');
      await watchOn(u);
      const before = t.metrics.truncated();

      await t.cycle();

      expect((await target(u)).lastPriceMinor).toBe('89900');
      expect(t.metrics.truncated()).toBe(before + 1);
    });

    it.each([['application/pdf'], ['image/png']])(
      'S41 AS-28: %s is refused once the headers are in',
      async (contentType) => {
        t.sites['rival.test'].page('/p/1', { contentType, body: 'binary' });
        const u = url('rival.test', '/p/1');
        await watchOn(u);

        await t.cycle();

        expect((await target(u)).lastStatus).toBe('unsupported_content_type');
      },
    );

    it('S41 AS-28: a page that never answers and one that drips a byte a second end at the 10 second deadline within the 30 second crawl, and the host is given back', async () => {
      t.sites['rival.test'].page('/hang', { hang: true });
      t.sites['rival.test'].page('/drip', {
        drip: true,
        body: 'x'.repeat(100),
      });
      const hang = url('rival.test', '/hang');
      const drip = url('rival.test', '/drip');
      await watchOn(hang);
      await watchOn(drip);

      const started = Date.now();
      await t.schedule();
      await t.drain();
      const elapsed = Date.now() - started;

      expect((await target(hang)).lastStatus).toBe('timeout');
      expect((await target(drip)).lastStatus).toBe('timeout');
      expect(elapsed).toBeGreaterThanOrEqual(19_000);
      expect(elapsed).toBeLessThan(60_000);
      expect(await t.frontier.readyHosts()).toBe(0);
    }, 90_000);

    it('S41 AS-28: a page that answers after 9 seconds is processed', async () => {
      t.sites['rival.test'].page('/p/1', {
        delayMs: 9_000,
        body: () => productPageOf(899),
      });
      const u = url('rival.test', '/p/1');
      await watchOn(u);

      await t.cycle();

      expect((await target(u)).lastStatus).toBe('ok');
    }, 60_000);
  });

  describe('shutdown', () => {
    it('S41 AS-30: a stopping worker takes no new target, finishes what is in flight and gives the host back', async () => {
      t.sites['rival.test'].page('/p/1', {
        delayMs: 2_000,
        body: () => productPageOf(899),
      });
      t.sites['rival.test'].priced('/p/2', 799);
      await watchOn(url('rival.test', '/p/1'));
      await watchOn(url('rival.test', '/p/2'));
      await t.schedule();

      const lone = t.extraWorker(1);
      lone.start();
      for (let i = 0; i < 100 && t.sites['rival.test'].inFlight === 0; i++)
        await new Promise((r) => setTimeout(r, 50));
      expect(t.sites['rival.test'].inFlight).toBe(1);
      await lone.stop();

      expect(pageRequests('rival.test').map((r) => r.path)).toEqual(['/p/1']);
      expect((await target(url('rival.test', '/p/1'))).lastStatus).toBe('ok');
      expect(await t.frontier.readyHosts()).toBe(1);
      t.skipGaps();
      await t.drain();
      expect(pageRequests('rival.test').map((r) => r.path)).toEqual([
        '/p/1',
        '/p/2',
      ]);
    }, 60_000);

    it('S41 AS-30: a worker that cannot finish within the grace period abandons the fetch and releases the host', async () => {
      t.sites['rival.test'].page('/hang', { hang: true });
      t.sites['rival.test'].priced('/p/2', 799);
      await watchOn(url('rival.test', '/hang'));
      await watchOn(url('rival.test', '/p/2'));
      await t.schedule();

      const lone = t.extraWorker(1);
      lone.start();
      for (let i = 0; i < 100 && t.sites['rival.test'].inFlight === 0; i++)
        await new Promise((r) => setTimeout(r, 50));
      const started = Date.now();
      await lone.stop(500);

      expect(Date.now() - started).toBeLessThan(5_000);
      // the abandoned host is not held for the 60 s lease: after the minimum gap another worker may take its next target
      const score = Number(
        await t.redis.zscore('crawl:{s}:ready', 'rival.test'),
      );
      expect(score - t.wallNow()).toBeLessThanOrEqual(1_500);
    }, 60_000);
  });
});

const productPageOf = (price: number) => productPage(price);
