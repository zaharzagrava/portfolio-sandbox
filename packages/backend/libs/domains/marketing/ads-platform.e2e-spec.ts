import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { Sequelize } from 'sequelize-typescript';
import {
  AD_PROBLEM_CODES,
  problemDetailsSchema,
  type AdClickRecord,
} from '@marketplace-sandbox/contracts';
import { ConfigRules } from '@app/common/config/config-rules';
import { adsConfigKeys } from '@app/common/config/ads-config';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { LedgerService, shopAccount } from '@app/domains/payments';
import { OWNERSHIP } from '../../../db/ownership';
import { waitFor } from '@app/test/utils/async-helpers';
import { testKafka } from '@app/test/utils/kafka-test';
import * as barrel from './index';
import { AdsWorkerModule } from './ads-worker.module';
import { LEDGER_PORT } from './domain/ads-ports';
import { ADS_CLICKS_TOPIC } from './domain/ads-constants';
import { formatReceivedAt } from './domain/click-record';
import { clickKey } from './domain/hot-key-salt';
import { hashViewer, signClickToken } from './domain/click-token';
import {
  AGGREGATOR_AUTOSTART,
  ClickAggregator,
} from './infra/click-aggregator.service';
import { LedgerAdapter } from './infra/ledger.adapter';
import {
  createAdsApp,
  resetAdsTopics,
  type AdsTestApp,
} from './testing/ads.fixtures';

const JWT = 'a-session-signing-secret-of-its-own-0123';
const CLICK = 'an-ad-click-secret-of-its-own-0123456789';
const OTHER = 'another-secret-of-its-own-0123456789abcd';

/** The environment as a deployment provides it for the ads keys, parsed like `ApiConfigService.init` does, plus the cross-key rules. */
function startup(
  over: Record<string, string | undefined> = {},
  values: Record<string, unknown> = {},
): string[] {
  const env = Object.fromEntries(
    Object.entries({
      ADS_CLICK_SECRET: CLICK,
      ADS_SPAM_IP_PER_MINUTE: '20',
      ADS_SPAM_REPEAT_PER_HOUR: '3',
      ADS_AGGREGATOR_INSTANCE: 'worker-0',
      ...over,
    }).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  let parsed: Record<string, unknown>;
  try {
    parsed = new ConfigUtilsService().parseSrc<Record<string, unknown>>(
      adsConfigKeys as never,
      [env],
    );
  } catch (error) {
    return [(error as Error).message];
  }
  return ConfigRules.validate(
    { jwt_secret: JWT, share_link_code_key: OTHER, ...parsed, ...values },
    { production: true },
  ).filter((line) => line.startsWith('[ads]'));
}

const MARKETING = join(__dirname);
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('Sponsored listings: operations and boundaries', () => {
  describe('S36 AS-77: configuration and secrets', () => {
    it('starts with a valid configuration, with defaults for the thresholds', () => {
      expect(startup()).toEqual([]);
      expect(
        startup({
          ADS_SPAM_IP_PER_MINUTE: undefined,
          ADS_SPAM_REPEAT_PER_HOUR: undefined,
        }),
      ).toEqual([]);
      expect(
        startup({
          ADS_CLICK_SECRET_PREVIOUS: OTHER.replace('another', 'previous'),
        }),
      ).toEqual([]);
    });

    it.each([
      [
        'the click secret is missing',
        { ADS_CLICK_SECRET: undefined },
        'ads_click_secret',
      ],
      [
        'the click secret is shorter than 32 bytes',
        { ADS_CLICK_SECRET: 'x'.repeat(31) },
        'ads_click_secret',
      ],
      [
        'the previous secret is shorter than 32 bytes',
        { ADS_CLICK_SECRET_PREVIOUS: 'x'.repeat(31) },
        'ads_click_secret_previous',
      ],
      [
        'the address threshold is 0',
        { ADS_SPAM_IP_PER_MINUTE: '0' },
        'ads_spam_ip_per_minute',
      ],
      [
        'the address threshold is negative',
        { ADS_SPAM_IP_PER_MINUTE: '-5' },
        'ads_spam_ip_per_minute',
      ],
      [
        'the address threshold is not an integer',
        { ADS_SPAM_IP_PER_MINUTE: '2.5' },
        'ads_spam_ip_per_minute',
      ],
      [
        'the address threshold is not a number',
        { ADS_SPAM_IP_PER_MINUTE: 'many' },
        'ads_spam_ip_per_minute',
      ],
      [
        'the repeat threshold is 0',
        { ADS_SPAM_REPEAT_PER_HOUR: '0' },
        'ads_spam_repeat_per_hour',
      ],
      [
        'the repeat threshold is not an integer',
        { ADS_SPAM_REPEAT_PER_HOUR: '1.5' },
        'ads_spam_repeat_per_hour',
      ],
      [
        'the worker slot name is missing',
        { ADS_AGGREGATOR_INSTANCE: undefined },
        'ads_aggregator_instance',
      ],
    ])('fails startup naming the key when %s', (_name, over, key) => {
      const found = startup(over);
      expect(found.length).toBeGreaterThan(0);
      expect(found.join(' ')).toContain(key);
    });

    it('fails when the click secret equals another secret, the previous one equals the current, and never falls back to the old key', () => {
      expect(startup({ ADS_CLICK_SECRET: JWT }).join(' ')).toMatch(
        /ads_click_secret must differ from jwt_secret/,
      );
      expect(startup({ ADS_CLICK_SECRET: OTHER }).join(' ')).toMatch(
        /ads_click_secret must differ from share_link_code_key/,
      );
      expect(startup({ ADS_CLICK_SECRET_PREVIOUS: CLICK }).join(' ')).toMatch(
        /ads_click_secret_previous must differ from ads_click_secret/,
      );
      // a configuration that has the old share-link key and no ads secret does not start
      expect(
        startup(
          { ADS_CLICK_SECRET: undefined },
          { share_link_secret: CLICK },
        ).join(' '),
      ).toContain('ads_click_secret');
    });
  });

  describe('S36 AS-80: boundaries and ownership', () => {
    const TABLES = [
      'AdCampaign',
      'AdBillingRun',
      'AdCampaignHistory',
      'AdProductSponsorship',
      'AdShopQuota',
      'AdProductSnapshot',
      'AdShopSnapshot',
      'AdBillingAdjustment',
      'AdReconciliationRun',
    ];

    it('the ownership registry lists every table of the capability as marketing', () => {
      for (const table of TABLES)
        expect((OWNERSHIP as Record<string, string>)[table]).toBe(
          'domain:marketing',
        );
    });

    it('the barrel exports only Nest modules, DTO types and event definitions of the ads half (no service, model, repository or consumer)', () => {
      const exported = Object.keys(barrel).filter(
        (name) =>
          !/^ShareLinks|^(LinkAttribution|TooManyCodes|AttributionUnavailable)|linkClickedEventSchema/.test(
            name,
          ),
      );
      expect(exported.sort()).toEqual(
        [
          'AdsModule',
          'AdsProjectorModule',
          'AdsWorkerModule',
          'CampaignCreated',
          'CampaignEnded',
          'CampaignPaused',
          'CampaignResumed',
          'ProductSponsorshipChanged',
        ].sort(),
      );
    });

    it('the ads code names no table of another owner and imports no model of another domain', () => {
      const own = /(AdCampaign|AdBilling|AdProduct|AdShop|AdReconciliation)/;
      const foreign =
        /\b(FROM|JOIN|INTO|UPDATE)\s+"(Product|Shop|ShopMembership|BisOrder|BisOrderItem|ShopOrder|LedgerEntry|LedgerJournal|AccountBalance)"/;
      const files = walk(MARKETING).filter(
        (f) =>
          f.endsWith('.ts') &&
          !/spec\.ts$/.test(f) &&
          !f.includes('/testing/') &&
          !/share-link|link-|redirect|code-format|destination|alias|codes|click-meta|filter-rebuild|list-cursor|dynamo|redis-code|redis-existence|redis-link|kafka-click\.publisher|clickhouse-click-stats|allow-all|idempotency-header|link-zod|ports\.ts$/.test(
            f,
          ),
      );
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        expect({
          file,
          foreignSql: foreign.test(text) && own.test(text),
        }).toEqual({ file, foreignSql: false });
        expect({
          file,
          model:
            /from '@app\/domains\/[a-z-]+'/.test(text) &&
            /\b\w+Model\b/.test(text),
        }).toEqual({ file, model: false });
      }
    });
  });

  describe('running system', () => {
    let t: AdsTestApp;
    const metric = (name: string, labels: Record<string, string> = {}) =>
      MetricsRegistry.value(name, labels) ?? 0;

    beforeAll(async () => {
      t = await createAdsApp({
        structuredLogger: true,
        spyProducer: false,
        redisProxy: true,
        extraImports: [AdsWorkerModule],
        customize: (b) =>
          b.overrideProvider(AGGREGATOR_AUTOSTART).useValue(false),
        ports: [{ dep: 'ledger', token: LEDGER_PORT, real: LedgerAdapter }],
      });
    });
    afterAll(async () => {
      await t.close();
    });
    beforeEach(async () => {
      await t.reset();
      await resetAdsTopics();
    });

    const secret = () => t.config.get('ads_click_secret');

    const migrations = join(__dirname, '../../../migrations');
    const load = (name: string) =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(join(migrations, name)) as {
        up(qi: unknown): Promise<void>;
        down(qi: unknown): Promise<void>;
      };
    const V2 = '20261013150000-ads-campaigns-v2.js';
    const FKS = '20261013150100-ads-drop-cross-owner-fks.js';

    it('S36 AS-81: the migrations run up, down and up again; each sets a lock timeout; none renames or drops a column that running code reads', async () => {
      const qi = t.app.get(Sequelize).getQueryInterface();
      for (const file of [V2, FKS]) {
        const source = readFileSync(join(migrations, file), 'utf8');
        expect(source).toMatch(/lock_timeout/);
        expect(source).not.toMatch(
          /RENAME\s+(COLUMN|TO)|DROP\s+COLUMN\s+(?!IF EXISTS\s+"(cpcMinor|dailyBudgetMinor|currency|statusReason|campaignVersion|updatedAt|state|source|billableClicks|cappedClicks|amountMinor|ledgerReference|chargedAt)")/i,
        );
      }
      const foreignKeys = () =>
        t.sql<{ name: string }>(
          `SELECT conname AS name FROM pg_constraint
            WHERE contype = 'f' AND conrelid = '"AdCampaign"'::regclass AND confrelid::regclass::text IN ('"Shop"', '"Product"', 'Shop', 'Product')`,
        );

      expect(await foreignKeys()).toEqual([]); // dropped by their own step
      await load(FKS).down(qi);
      expect((await foreignKeys()).length).toBe(2);
      await load(V2).down(qi);
      expect(
        await t.sql(
          `SELECT 1 FROM information_schema.tables WHERE table_name = 'AdBillingAdjustment'`,
        ),
      ).toEqual([]);
      await load(V2).up(qi);
      await load(FKS).up(qi);
      expect(await foreignKeys()).toEqual([]);
      expect(
        await t.sql(
          `SELECT 1 FROM information_schema.tables WHERE table_name = 'AdBillingAdjustment'`,
        ),
      ).toHaveLength(1);
      // idempotent: a second up changes nothing and fails nothing
      await load(V2).up(qi);
    });

    it('S36 AS-76: the instruments carry exactly the documented names, labels are bounded outcomes and nothing identifying', async () => {
      // static: the names defined by the capability are exactly the documented set
      const defined = [
        ...readFileSync(
          join(MARKETING, 'domain/ads-metrics.ts'),
          'utf8',
        ).matchAll(/name: '(ads_[a-z_]+)'/g),
      ].map((m) => m[1]);
      expect(defined.sort()).toEqual(
        [
          'ads_impressions_total',
          'ads_clicks_total',
          'ads_late_clicks_total',
          'ads_aggregator_batches_total',
          'ads_aggregator_fenced_total',
          'ads_billing_charged_minor_total',
          'ads_billing_adjustment_minor_total',
          'ads_billing_orphan_aggregate_total',
          'ads_billing_lag_seconds',
          'ads_reconciliation_runs_total',
          'ads_reconciliation_drift_ratio',
        ].sort(),
      );

      // a scripted run: serve, click (counted, duplicate), aggregate a late click, bill, reconcile
      const team = await t.team();
      const { campaign } = await t.campaign(team, {
        cpcMinor: 25,
        dailyBudgetMinor: 100_000,
      });
      const slots = (await t.http().get('/api/ads/sponsored?category=audio'))
        .body.items;
      const token = slots[0].clickUrl.split('/').pop() as string;
      await t.http().get(`/api/ads/click/${token}`).redirects(0);
      await t.http().get(`/api/ads/click/${token}`).redirects(0);

      const record: AdClickRecord = {
        click_id: uuidv7(),
        campaign_id: campaign.id,
        shop_id: team.shop.id,
        product_id: campaign.productId,
        received_at: formatReceivedAt(new Date(t.clock.nowMs() - 600_000)),
        ip_hash: 'a'.repeat(32),
        viewer_hash: 'b'.repeat(32),
        valid: 1,
        invalid_reason: null,
      };
      const producer = testKafka().producer();
      await producer.connect();
      await producer.send({
        topic: ADS_CLICKS_TOPIC,
        messages: [
          {
            key: clickKey(campaign.id, record.click_id),
            value: JSON.stringify(record),
          },
        ],
      });
      await producer.disconnect();
      const handle = await t.app
        .get(ClickAggregator)
        .start({ groupId: `g-${uuidv4()}`, transactionalId: `tx-${uuidv4()}` });
      await waitFor(
        async () =>
          metric('ads_aggregator_batches_total', { result: 'processed' }) >= 1,
        { description: 'a batch was aggregated', timeoutMs: 30_000 },
      );
      await handle.stop();

      const hour = new Date(Date.parse('2026-10-05T10:00:00Z'));
      const day = '2026-10-05';
      await t.sql(
        `INSERT INTO "AdBillingRun" ("campaignId","hour","state","source","clicks","billableClicks","cappedClicks","amountMinor","ledgerReference","chargedAt")
         VALUES (:id, :hour, 'CHARGED', 'stream', 12, 12, 0, 300, :ref, now()) RETURNING 1`,
        { id: campaign.id, hour, ref: `ad:${campaign.id}:2026-10-05T10` },
      );
      t.clock.set(
        new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000 + 9_000_000),
      );
      await t.runJob('ads.reconcile-day', { day });
      await t.runJob('ads.bill-hour', { hour: '2026-10-05T10' });

      for (const name of [
        'ads_impressions_total',
        'ads_clicks_total',
        'ads_late_clicks_total',
        'ads_aggregator_batches_total',
        'ads_billing_lag_seconds',
        'ads_reconciliation_runs_total',
        'ads_reconciliation_drift_ratio',
        'ads_billing_adjustment_minor_total',
      ])
        expect({ name, series: MetricsRegistry.seriesCount(name) }).toEqual({
          name,
          series: expect.any(Number),
        });
      expect(
        metric('ads_impressions_total', { result: 'served' }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        metric('ads_clicks_total', { outcome: 'counted' }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        metric('ads_clicks_total', { outcome: 'duplicate' }),
      ).toBeGreaterThanOrEqual(1);
      expect(metric('ads_late_clicks_total')).toBeGreaterThanOrEqual(1);
      expect(
        metric('ads_reconciliation_runs_total', { status: 'completed' }),
      ).toBeGreaterThanOrEqual(1);

      // labels: bounded vocabularies; no campaign, shop, token or address value anywhere
      const allowed: Record<string, string[]> = {
        ads_impressions_total: ['result'],
        ads_clicks_total: ['outcome'],
        ads_aggregator_batches_total: ['result'],
        ads_billing_adjustment_minor_total: ['direction'],
        ads_reconciliation_runs_total: ['status'],
        ads_reconciliation_drift_ratio: ['day'],
      };
      for (const [name, keys] of Object.entries(allowed))
        for (const labels of MetricsRegistry.labelSets(name)) {
          expect(Object.keys(labels).every((k) => keys.includes(k))).toBe(true);
          for (const value of Object.values(labels))
            expect(String(value)).not.toMatch(
              /[0-9a-f]{8}-[0-9a-f]{4}-|\d+\.\d+\.\d+\.\d+|v1\./,
            );
        }
    }, 120_000);

    it('S36 AS-78: every error is problem+json with a stable code and a request id; a 5xx has a generic detail', async () => {
      const team = await t.team();
      const { campaign, product } = await t.campaign(team);
      const other = await t.team();
      const body = (productId: string, over: Record<string, unknown> = {}) => ({
        productId,
        cpcMinor: 25,
        dailyBudgetMinor: 1_000,
        ...over,
      });
      const cases: Array<[string, Promise<{ status: number; body: unknown }>]> =
        [
          [
            'validation_failed',
            t.create(team.owner, team.shop.id, { nope: 1 }),
          ],
          [
            'invalid_token',
            t
              .http()
              .post(`/api/shops/${team.shop.id}/ads/campaigns`)
              .send(body(product.id)),
          ],
          [
            'permission_denied',
            t.create(team.viewer, team.shop.id, body(product.id)),
          ],
          [
            'shop_not_found',
            t.as(team.owner).get(`/api/shops/${other.shop.id}/ads/campaigns`),
          ],
          [
            'product_not_found',
            t.create(team.owner, team.shop.id, body(uuidv4())),
          ],
          [
            'campaign_not_found',
            t
              .as(team.owner)
              .get(`/api/shops/${team.shop.id}/ads/campaigns/${uuidv4()}`),
          ],
          [
            'campaign_already_exists',
            t.create(team.owner, team.shop.id, body(product.id)),
          ],
          [
            'invalid_transition',
            t.act(team.owner, team.shop.id, campaign.id, 'resume'),
          ],
          [
            'budget_below_cpc',
            t.create(
              team.owner,
              team.shop.id,
              body(product.id, { cpcMinor: 500, dailyBudgetMinor: 400 }),
            ),
          ],
          [
            'invalid_cursor',
            t
              .as(team.owner)
              .get(`/api/shops/${team.shop.id}/ads/campaigns?cursor=abc.def`),
          ],
          [
            'product_not_sponsorable',
            (async () =>
              t.create(
                team.owner,
                team.shop.id,
                body((await t.product(team.shop.id, { isSandbox: true })).id),
              ))(),
          ],
        ];
      for (const [code, request] of cases) {
        const res = await request;
        const problem = problemDetailsSchema.parse(res.body);
        expect({ code, got: problem.code }).toEqual({ code, got: code });
        expect(AD_PROBLEM_CODES as readonly string[]).toContain(problem.code);
        expect(problem.requestId).toBeTruthy();
      }

      t.faults.set('campaigns.insert', { kind: 'down' });
      const product2 = await t.product(team.shop.id);
      const failed = await t.create(
        team.owner,
        team.shop.id,
        body(product2.id),
      );
      expect(failed.status).toBe(500);
      const problem = problemDetailsSchema.parse(failed.body);
      expect(`${problem.title} ${problem.detail}`).not.toMatch(
        /campaign|insert|sequelize|postgres|select|unavailable|\.ts/i,
      );
      expect(failed.body).not.toHaveProperty('stack');
      expect(problem.detail.length).toBeLessThan(200);
    });

    it('S36 AS-79: the log of serve → click → bill holds no token, secret, raw address or request body', async () => {
      const team = await t.team();
      const { campaign } = await t.campaign(team, {
        cpcMinor: 25,
        dailyBudgetMinor: 100_000,
      });
      const slots = (
        await t
          .http()
          .get('/api/ads/sponsored?category=audio')
          .set('x-anonymous-id', 'ANON-MARKER-77')
      ).body.items;
      const token = slots[0].clickUrl.split('/').pop() as string;
      const forged = signClickToken(
        {
          i: uuidv7(),
          c: campaign.id,
          s: team.shop.id,
          p: campaign.productId,
          e: t.clock.nowMs() + 60_000,
          v: hashViewer(secret(), 'anon:x'),
        },
        { current: secret() },
      );
      await t.http().get(`/api/ads/click/${token}`).redirects(0);
      await t.http().get(`/api/ads/click/${forged}`).redirects(0);
      await t.http().get('/api/ads/click/garbage-token-marker').redirects(0);
      await t.create(team.owner, team.shop.id, {
        productId: campaign.productId,
        cpcMinor: 25,
        dailyBudgetMinor: 1000,
        BODYMARKER: 'BODY-MARKER-991',
      });
      const hour = '2026-10-05T10';
      t.clock.set(new Date(Date.parse(`${hour}:00:00Z`) + 3_900_000 + 420_000));
      await t.runJob('ads.bill-hour', { hour });
      await t.app.get(LedgerService).getBalances({
        accountIds: [shopAccount(team.shop.id)],
        currency: 'EUR',
      });

      const logs = t.rawLogs();
      expect(logs.length).toBeGreaterThan(0);
      for (const forbidden of [
        token,
        forged,
        token.split('.')[3],
        secret(),
        t.config.get('jwt_secret'),
        '127.0.0.1',
        '::ffff:',
        'ANON-MARKER-77',
        'BODY-MARKER-991',
        'garbage-token-marker',
      ])
        expect({ forbidden, found: logs.includes(forbidden) }).toEqual({
          forbidden,
          found: false,
        });
    });

    it('S36 AS-82: a stop in the middle of a batch leaves no open transaction and the batch is processed exactly once after the restart; a start that fails fails', async () => {
      const campaign = uuidv4();
      const records = Array.from({ length: 200 }, (): AdClickRecord => ({
        click_id: uuidv7(),
        campaign_id: campaign,
        shop_id: uuidv4(),
        product_id: uuidv4(),
        received_at: formatReceivedAt(new Date(t.clock.nowMs() - 5_000)),
        ip_hash: 'a'.repeat(32),
        viewer_hash: 'b'.repeat(32),
        valid: 1,
        invalid_reason: null,
      }));
      const producer = testKafka().producer();
      await producer.connect();
      await producer.send({
        topic: ADS_CLICKS_TOPIC,
        messages: records.map((r) => ({
          key: clickKey(r.campaign_id, r.click_id),
          value: JSON.stringify(r),
        })),
      });
      await producer.disconnect();
      const ids = {
        groupId: `g-${uuidv4()}`,
        transactionalId: `tx-${uuidv4()}`,
      };
      const aggregator = t.app.get(ClickAggregator);

      let inBatch!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((r) => (inBatch = r));
      const gate = new Promise<void>((r) => (release = r));
      await aggregator.start({
        ...ids,
        afterEmit: async () => {
          inBatch();
          await gate;
        },
      });
      await reached;
      const stopping = aggregator.stop();
      release();
      await stopping;

      // a reader that sees only committed data is not blocked by a dangling transaction, and nothing is counted twice
      const handle = await aggregator.start(ids);
      const admin = testKafka().admin();
      await admin.connect();
      await waitFor(
        async () => {
          const [found] = await admin.fetchOffsets({
            groupId: ids.groupId,
            topics: [ADS_CLICKS_TOPIC],
          });
          return (
            found.partitions.reduce(
              (n, p) => n + Math.max(0, Number(p.offset)),
              0,
            ) === 200
          );
        },
        {
          description: 'every offset committed after the restart',
          timeoutMs: 60_000,
        },
      );
      await admin.disconnect();
      await handle.stop();

      const reader = testKafka().consumer({
        groupId: `rc-${uuidv4()}`,
        readUncommitted: false,
      });
      let clicks = 0;
      await reader.connect();
      await reader.subscribe({
        topic: 'ads.click-aggregates',
        fromBeginning: true,
      });
      await reader.run({
        eachMessage: async ({ message }) =>
          void (clicks += JSON.parse(message.value!.toString()).clicks),
      });
      // wait until all 200 are seen (up to 10 s), then a short grace so a late duplicate would still be counted (was a fixed 3 s)
      for (let i = 0; i < 200 && clicks < 200; i++)
        await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 500));
      await reader.disconnect();
      expect(clicks).toBe(200);

      t.config.set('kafka_broker', '127.0.0.1:1');
      await expect(aggregator.start()).rejects.toBeDefined();
    }, 180_000);
  });
});
