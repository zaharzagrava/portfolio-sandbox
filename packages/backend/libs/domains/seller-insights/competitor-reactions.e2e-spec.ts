import { Test } from '@nestjs/testing';
import {
  GetBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { ConfigRules } from '@app/common/config/config-rules';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { Environment } from '@app/common/types';
import {
  createCompetitorApp,
  T0,
  type CompetitorTestApp,
  type SeededShop,
} from './testing/competitor-fixtures';
import {
  CrawlerConfig,
  CrawlerConfigError,
} from './application/crawler.config';
import {
  CompetitorProductProjector,
  CompetitorShopProjector,
} from './infra/projectors/competitor.projectors';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const U1 = 'https://rival.test/p/1';
const U2 = 'https://rival.test/p/2';

describe('Competitor monitor: shop and product events, retention, operability', () => {
  let t: CompetitorTestApp;
  let A: SeededShop;
  const shops = () => t.projector(CompetitorShopProjector);
  const products = () => t.projector(CompetitorProductProjector);
  const site = () => t.sites['rival.test'];

  beforeAll(async () => {
    t = await createCompetitorApp({ sites: ['rival.test', 'other.test'] });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    A = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
  });

  const watch = async (url: string, shop: SeededShop = A) => {
    const p = await t.product(shop.shopId);
    return {
      ...(await t.register(shop.owner, shop.shopId, p.id, url)),
      productId: p.id,
    };
  };
  const shopRow = async (shopId: string) =>
    (
      await t.pg<{
        shopId: string;
        plan: string | null;
        status: string;
        version: number;
      }>(
        `SELECT "shopId", "plan", "status", "version" FROM "CompetitorShop" WHERE "shopId" = :shopId`,
        { shopId },
      )
    )[0];
  const statuses = async (shopId = A.shopId) =>
    (await t.watchRows(shopId)).map((w) => w.status);

  describe('shop events', () => {
    it('S41 AS-51: suspending pauses the watches, reinstating resumes them, a stale or repeated version changes nothing', async () => {
      await watch(U1);
      site().priced('/p/1', 899);
      expect(await shopRow(A.shopId)).toMatchObject({
        plan: 'PRO',
        status: 'ACTIVE',
        version: 1,
      });

      await t.deliver(shops(), [
        t.shopStatusChanged({
          shopId: A.shopId,
          to: 'SUSPENDED',
          shopVersion: 3,
        }),
      ]);
      expect(await statuses()).toEqual(['PAUSED']);
      expect(await t.schedule()).toBe(0);
      const listed = await t
        .as(A.owner)
        .get(`/api/shops/${A.shopId}/competitors`)
        .expect(200);
      expect(listed.body.items[0].status).toBe('PAUSED');

      await t.deliver(shops(), [
        t.shopStatusChanged({ shopId: A.shopId, to: 'ACTIVE', shopVersion: 4 }),
      ]);
      expect(await statuses()).toEqual(['ACTIVE']);
      expect(await t.schedule()).toBe(1);

      // 4, 3, 4, 3: the state is the one of version 4 and nothing flips back
      await t.deliver(shops(), [
        t.shopStatusChanged({ shopId: A.shopId, to: 'ACTIVE', shopVersion: 4 }),
        t.shopStatusChanged({
          shopId: A.shopId,
          to: 'SUSPENDED',
          shopVersion: 3,
        }),
        t.shopStatusChanged({ shopId: A.shopId, to: 'ACTIVE', shopVersion: 4 }),
        t.shopStatusChanged({
          shopId: A.shopId,
          to: 'SUSPENDED',
          shopVersion: 3,
        }),
      ]);
      expect(await shopRow(A.shopId)).toMatchObject({
        status: 'ACTIVE',
        version: 4,
      });
      expect(await statuses()).toEqual(['ACTIVE']);
    });

    it('S41 AS-51: a plan change reorders the queue at the next cycle', async () => {
      const B = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
      await watch(U1);
      await watch(U2, B);
      const idOf = async (url: string) => (await t.target(url))!.id;
      // the other shop's target is due first, so only the plan can put shop A's target ahead of it
      await t.pg(
        `UPDATE "CrawlTarget" SET "nextCheckAt" = :at WHERE "url" = :url`,
        { at: new Date(T0.getTime() - HOUR), url: U2 },
      );
      const queued = () => t.redis.lrange('crawl:{s}:host:rival.test', 0, -1);
      const clear = async () => {
        for (const entry of await t.keys('crawl:*'))
          await t.redis.del(entry.key);
      };

      expect(await t.schedule(1)).toBe(1);
      expect(await queued()).toEqual([await idOf(U2)]);
      await clear();

      await t.deliver(shops(), [
        t.shopPlanChanged({
          shopId: A.shopId,
          plan: 'ENTERPRISE',
          shopVersion: 5,
        }),
      ]);
      expect(await shopRow(A.shopId)).toMatchObject({
        plan: 'ENTERPRISE',
        version: 5,
      });
      expect(await t.schedule(1)).toBe(1);

      expect(await queued()).toEqual([await idOf(U1)]);
    });

    it('S41 AS-51: a deleted shop erases its watches and row, retires unwatched targets, and a repeat changes nothing', async () => {
      const B = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
      await watch(U1);
      await watch(U1, B);
      await watch(U2);

      for (let i = 0; i < 2; i++) {
        await t.deliver(shops(), [t.shopDeleted(A.shopId)]);
        expect(await t.watchRows(A.shopId)).toHaveLength(0);
        expect(await shopRow(A.shopId)).toBeUndefined();
        expect((await t.target(U1))!.retiredAt).toBeNull();
        expect((await t.target(U2))!.retiredAt).not.toBeNull();
        expect(await t.watchRows(B.shopId)).toHaveLength(1);
      }
    });

    it('S41 AS-51: a status event before the shop is known creates its row and the later creation fills the plan', async () => {
      const shopId = uuidv4();
      await t.deliver(shops(), [
        t.shopStatusChanged({ shopId, to: 'SUSPENDED', shopVersion: 3 }),
      ]);
      expect(await shopRow(shopId)).toMatchObject({
        plan: null,
        status: 'SUSPENDED',
        version: 3,
      });

      await t.deliver(shops(), [
        t.shopCreated({ shopId, plan: 'PRO', shopVersion: 1 }),
      ]);
      expect(await shopRow(shopId)).toMatchObject({
        plan: 'PRO',
        status: 'SUSPENDED',
        version: 3,
      });
    });
  });

  describe('product events', () => {
    it('S41 AS-52: the watches of a deleted product go once, the others stay, targets nobody watches are retired', async () => {
      const w1 = await watch(U1);
      const w2 = await watch(U2);
      const event = t.productDeleted({
        productId: w1.productId,
        shopId: A.shopId,
      });

      await t.deliver(products(), [event]);
      await t.deliver(products(), [event]);

      expect((await t.watchRows()).map((w) => w.id)).toEqual([w2.id]);
      expect((await t.target(U1))!.retiredAt).not.toBeNull();
      expect((await t.target(U2))!.retiredAt).toBeNull();

      const unwatched = await t.deliver(products(), [
        t.productDeleted({ productId: uuidv4(), shopId: A.shopId }),
      ]);
      expect(unwatched.deadLettered).toEqual([]);
      expect(await t.watchRows()).toHaveLength(1);
    });
  });

  describe('invalid payloads', () => {
    const id = () => uuidv4();
    const created = (over: Record<string, unknown>) => ({
      shopId: id(),
      ownerId: null,
      name: 'Shop',
      slug: 'shop',
      plan: 'PRO',
      region: 'eu-central-1',
      shopVersion: 1,
      ...over,
    });

    it.each([
      [
        'no shop id',
        () => ['tenancy.shop_created', created({ shopId: undefined }), 1],
      ],
      [
        'a shop id that is not a UUID',
        () => ['tenancy.shop_created', created({ shopId: 'nope' }), 1],
      ],
      [
        'an unknown plan',
        () => ['tenancy.shop_created', created({ plan: 'DIAMOND' }), 1],
      ],
      [
        'an unknown status',
        () => [
          'tenancy.shop_status_changed',
          { shopId: id(), from: 'ACTIVE', to: 'BANNED', shopVersion: 2 },
          1,
        ],
      ],
      [
        'a version that is not an integer',
        () => [
          'tenancy.shop_status_changed',
          { shopId: id(), from: 'ACTIVE', to: 'SUSPENDED', shopVersion: 1.5 },
          1,
        ],
      ],
      [
        'an envelope version it does not support',
        () => ['tenancy.shop_created', created({}), 2],
      ],
    ] as const)(
      'S41 AS-53: %s is dead-lettered with a reason and changes nothing; the next valid message is applied',
      async (_name, make) => {
        const [type, payload, version] = make() as [
          string,
          Record<string, unknown>,
          number,
        ];
        const good = t.shopCreated({
          shopId: id(),
          plan: 'STARTER',
          shopVersion: 1,
        });
        const bad = t.raw(
          type,
          'tenancy',
          (payload.shopId as string) ?? id(),
          payload,
          { version },
        );
        const before = await t.pg(`SELECT * FROM "CompetitorShop"`);

        const result = await t.deliver(shops(), [bad, good]);

        expect(result.deadLettered).toHaveLength(1);
        expect(result.deadLettered[0].event.eventId).toBe(bad.eventId);
        expect(result.deadLettered[0].reason).toEqual(expect.any(String));
        const after = await t.pg<{ shopId: string }>(
          `SELECT * FROM "CompetitorShop"`,
        );
        expect(after.length).toBe(before.length + 1);
        expect(after.map((r) => r.shopId)).toContain(good.aggregateId);
      },
    );

    it('S41 AS-53: an event of another type on the topic is ignored without a dead letter', async () => {
      const result = await t.deliver(shops(), [
        t.raw('tenancy.member_added', 'tenancy', id(), {
          shopId: id(),
          userId: id(),
          role: 'STAFF',
          source: 'invite',
        }),
      ]);

      expect(result.deadLettered).toEqual([]);
      expect(await t.pg(`SELECT * FROM "CompetitorShop"`)).toHaveLength(1);
    });

    it('S41 AS-53: a product event with no shop or a malformed product id is dead-lettered', async () => {
      const w = await watch(U1);
      const result = await t.deliver(products(), [
        t.raw('catalog.product_deleted', 'products', w.productId, {
          productId: w.productId,
          productVersion: 3,
        }),
        t.raw('catalog.product_deleted', 'products', id(), {
          productId: 'x',
          shopId: A.shopId,
          productVersion: 3,
        }),
      ]);

      expect(result.deadLettered).toHaveLength(2);
      expect(await t.watchRows()).toHaveLength(1);
    });

    it('S41 AS-53: a delivery repeated has the effect of one', async () => {
      const event = t.shopStatusChanged({
        shopId: A.shopId,
        to: 'SUSPENDED',
        shopVersion: 7,
      });
      await watch(U1);
      await t.deliver(shops(), [event]);
      await t.deliver(shops(), [event]);

      expect(await shopRow(A.shopId)).toMatchObject({
        status: 'SUSPENDED',
        version: 7,
      });
      expect(await statuses()).toEqual(['PAUSED']);
    });
  });

  describe('retention', () => {
    it('S41 AS-54: a target without a watch for 30 days is deleted once, however often and however many replicas run the purge', async () => {
      await watch(U1);
      const w2 = await watch(U2);
      await t.pg(`DELETE FROM "CompetitorWatch" WHERE "id" != :keep`, {
        keep: w2.id,
      });
      await t.targets.retireUnwatched(
        [(await t.target(U1))!.id],
        new Date(T0.getTime() - 31 * DAY),
      );
      const young = 'https://rival.test/p/young';
      await watch(young);
      await t.pg(
        `DELETE FROM "CompetitorWatch" WHERE "productId" = (SELECT "productId" FROM "CompetitorWatch" ORDER BY "createdAt" DESC, "id" DESC LIMIT 1)`,
      );
      await t.targets.retireUnwatched(
        [(await t.target(young))!.id],
        new Date(T0.getTime() - 5 * DAY),
      );

      const deleted = await Promise.all([
        t.retention.purge(),
        t.retention.purge(),
      ]);
      const again = await t.retention.purge();

      expect(deleted.reduce((a, b) => a + b, 0)).toBe(1);
      expect(again).toBe(0);
      expect(await t.target(U1)).toBeUndefined();
      expect(await t.target(U2)).toBeDefined();
      expect(await t.target(young)).toBeDefined();
    });

    it('S41 AS-54: the archive expires after 7 days by a lifecycle rule and the history after 2 years by a table rule', async () => {
      const config = t.app.get(ApiConfigService);
      const s3 = new S3Client({
        region: config.get('aws_region') || 'eu-central-1',
        endpoint: config.get('s3_endpoint'),
        forcePathStyle: true,
        credentials: {
          accessKeyId: (config.get('s3_access_key_id') ??
            config.get('aws_access_key_id'))!,
          secretAccessKey: (config.get('s3_secret_access_key') ??
            config.get('aws_secret_access_key'))!,
        },
      });
      const { Rules } = await s3.send(
        new GetBucketLifecycleConfigurationCommand({
          Bucket: config.get('media_bucket') ?? 'marketplace-media',
        }),
      );
      const rule = Rules?.find((r) => r.ID === 's41-crawl-archive-7d');
      expect(rule).toMatchObject({
        Status: 'Enabled',
        Expiration: { Days: 7 },
      });
      expect(rule?.Filter?.Prefix ?? rule?.Prefix).toBe('crawl/');

      const ddl = (await (
        await t.app.get(ClickHouseService).getClient().query({
          query: 'SHOW CREATE TABLE competitor_prices',
          format: 'JSONEachRow',
        })
      ).json()) as Array<{ statement: string }>;
      expect(ddl[0].statement).toMatch(
        /TTL[^\n]*(INTERVAL 2 YEAR|toIntervalYear\(2\))/i,
      );
    });
  });

  describe('observability and configuration', () => {
    it('S41 AS-55: crawls of every outcome are counted, the gauges are exposed and log lines carry ids but never the URL, query or body', async () => {
      t.crawl.random = () => 0.5;
      const m = t.metrics;
      const names = [
        'ok',
        'unchanged',
        'no_price',
        'disallowed_by_robots',
        'http_429',
        'blocked_address',
      ];
      const before = Object.fromEntries(names.map((n) => [n, m.fetch(n)]));
      const robotsBefore = m.robots('fetched');

      site().priced('/p/1', 899);
      await watch(U1);
      await t.cycle(); // ok
      t.advance(13 * HOUR);
      await t.cycle(); // unchanged
      site().page('/p/1', {
        body: '<html>' + 'Nothing for sale here. '.repeat(80) + '</html>',
      });
      t.advance(49 * HOUR);
      await t.cycle(); // no_price
      site().page('/p/1', { status: 429, body: 'wait' });
      t.advance(25 * HOUR);
      await t.cycle(); // http_429
      t.net.set('rival.test', '10.0.0.5');
      t.advance(25 * HOUR);
      await t.cycle(); // blocked_address
      t.net.resetTable();
      site().robots = { body: 'User-agent: *\nDisallow: /p/' };
      t.advance(25 * HOUR);
      await t.redis.del('crawl:robots:https://rival.test:443');
      await t.cycle(); // disallowed_by_robots

      for (const name of names) expect(m.fetch(name)).toBe(before[name] + 1);
      expect(m.robots('fetched')).toBeGreaterThan(robotsBefore);
      await t.schedule();
      expect(m.overdue()).toBeGreaterThanOrEqual(0);
      expect(m.oldestOverdue()).toBeGreaterThanOrEqual(0);
      expect(m.readyHosts()).toBeGreaterThanOrEqual(0);

      for (const { line } of t.logs()) {
        const text = JSON.stringify(line);
        expect(text).not.toMatch(
          /rival\.test\/|\?|Nothing for sale|10\.0\.0\.5/,
        );
        if (
          String(line.event).startsWith('crawl') ||
          String(line.event).includes('archive')
        )
          expect(line).toEqual(
            expect.objectContaining({
              targetId: expect.any(String),
              host: 'rival.test',
            }),
          );
      }
    });

    it('S41 AS-55: failing stores log the target and host with a crawl id, never the URL', async () => {
      site().priced('/p/1', 899);
      await watch(U1);
      t.faults.archive = true;
      await t.cycle();
      t.faults.archive = false;
      await t.failOutbox(true);
      t.advance(13 * HOUR);
      site().priced('/p/1', 799);
      await t.cycle();
      await t.failOutbox(false);

      const lines = t
        .logs()
        .map((l) => l.line)
        .filter((l) => l.crawlId);
      expect(lines.map((l) => l.event)).toEqual(
        expect.arrayContaining(['archive_failed', 'observation_rolled_back']),
      );
      for (const line of lines) {
        expect(line).toMatchObject({
          crawlId: expect.any(String),
          targetId: expect.any(String),
          host: 'rival.test',
        });
        expect(JSON.stringify(line)).not.toMatch(/\/p\/1|rival\.test\//);
      }
    });

    const build = (
      values: Record<string, unknown>,
      node_env = Environment.test,
    ) =>
      Test.createTestingModule({
        providers: [
          CrawlerConfig,
          {
            provide: ApiConfigService,
            useValue: {
              get: (key: string) =>
                key === 'node_env' ? node_env : values[key],
            },
          },
        ],
      }).compile();

    it.each([
      [
        'fetch loops outside 1 to 64',
        { crawler_fetch_loops: 65 },
        'crawler_fetch_loops',
      ],
      ['fetch loops of 0', { crawler_fetch_loops: 0 }, 'crawler_fetch_loops'],
      [
        'a politeness minimum below 1 s',
        { crawler_min_gap_ms: 500 },
        'crawler_min_gap_ms',
      ],
      [
        'a per-request cap above 8 MiB',
        { crawler_max_body_bytes: 9 * 1024 * 1024 },
        'crawler_max_body_bytes',
      ],
    ])(
      'S41 AS-56: %s stops the application naming the key',
      async (_name, values, key) => {
        await expect(build(values)).rejects.toThrow(key);
        await expect(build(values)).rejects.toThrow(CrawlerConfigError);
      },
    );

    it('S41 AS-56: the fixture allowlist fails start-up in production and is honoured elsewhere; valid values start', async () => {
      await expect(
        build({ crawler_fixture_hosts: 'rival.test' }, Environment.production),
      ).rejects.toThrow('crawler_fixture_hosts');
      expect(
        ConfigRules.validate(
          { crawler_fixture_hosts: 'rival.test' },
          { production: true },
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining('crawler_fixture_hosts'),
        ]),
      );
      expect(
        ConfigRules.validate(
          { crawler_fixture_hosts: 'rival.test' },
          { production: false },
        ),
      ).toEqual(
        expect.not.arrayContaining([
          expect.stringContaining('crawler_fixture_hosts'),
        ]),
      );
      const module = await build({
        crawler_fixture_hosts: 'rival.test',
        crawler_fetch_loops: 8,
      });
      expect(module.get(CrawlerConfig).settings).toMatchObject({
        fetchLoops: 8,
        fixtureHosts: ['rival.test'],
      });
      await module.close();
      const defaults = await build({});
      expect(defaults.get(CrawlerConfig).settings.fetchLoops).toBe(16);
      await defaults.close();
    });
  });
});
