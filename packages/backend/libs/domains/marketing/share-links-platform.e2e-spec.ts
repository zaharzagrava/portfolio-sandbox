import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import { ConfigRules } from '@app/common/config/config-rules';
import { shareLinksConfigKeys } from '@app/common/config/share-links-config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import type { TestUser } from '@app/test/utils/catalog-app';
import * as barrel from './index';
import {
  createShareLinksApp,
  type ShareLinksTestApp,
} from './testing/share-links.fixtures';

const CODE_KEY = 'unit-share-link-code-key-0123456789abc';
const EDGE_SECRET = 'unit-share-link-edge-secret-0123456789a';
const JWT = 'a-session-signing-secret-of-its-own-0123';
const AD_SECRET = 'an-ad-click-secret-of-its-own-0123456789';

/** The environment as a deployment would provide it for the share-link keys. */
const env = (over: Record<string, string | undefined> = {}) =>
  Object.fromEntries(
    Object.entries({
      SHARE_LINK_CODE_KEY: CODE_KEY,
      SHARE_LINK_EDGE_SECRET: EDGE_SECRET,
      SHARE_LINK_BASE_URL: 'https://mkt.to',
      SHARE_LINK_MAX_PER_OWNER: '1000',
      ...over,
    }).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;

/** Joi (startup parsing of the keys) plus the cross-key rules, as `ApiConfigService.init` applies them. */
function startup(
  over: Record<string, string | undefined> = {},
  values: Record<string, unknown> = {},
): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = new ConfigUtilsService().parseSrc<Record<string, unknown>>(
      shareLinksConfigKeys as never,
      [env(over)],
    );
  } catch (error) {
    return [(error as Error).message];
  }
  return ConfigRules.validate(
    {
      front_host: 'https://shop.example',
      jwt_secret: JWT,
      ads_click_secret: AD_SECRET,
      ...parsed,
      ...values,
    },
    { production: true },
  ).filter((line) => line.startsWith('[share-links]')); // the other capabilities' production rules are theirs
}

describe('Share links: operations and boundaries', () => {
  describe('S37 AS-62: configuration', () => {
    it('starts with a valid configuration', () => {
      expect(startup()).toEqual([]);
      expect(startup({ SHARE_LINK_MAX_PER_OWNER: undefined })).toEqual([]); // defaults to 1,000
    });

    it.each([
      [
        'the code key is missing',
        { SHARE_LINK_CODE_KEY: undefined },
        'share_link_code_key',
      ],
      [
        'the code key is shorter than 32 bytes',
        { SHARE_LINK_CODE_KEY: 'x'.repeat(31) },
        'share_link_code_key',
      ],
      [
        'the edge secret is missing',
        { SHARE_LINK_EDGE_SECRET: undefined },
        'share_link_edge_secret',
      ],
      [
        'the edge secret is shorter than 32 bytes',
        { SHARE_LINK_EDGE_SECRET: 'x'.repeat(31) },
        'share_link_edge_secret',
      ],
      [
        'the base URL is missing',
        { SHARE_LINK_BASE_URL: undefined },
        'share_link_base_url',
      ],
      [
        'the base URL is http',
        { SHARE_LINK_BASE_URL: 'http://mkt.to' },
        'share_link_base_url',
      ],
      [
        'the base URL is not a URL',
        { SHARE_LINK_BASE_URL: 'mkt.to' },
        'share_link_base_url',
      ],
      [
        'the per-owner limit is zero',
        { SHARE_LINK_MAX_PER_OWNER: '0' },
        'share_link_max_per_owner',
      ],
      [
        'the per-owner limit is not a number',
        { SHARE_LINK_MAX_PER_OWNER: 'many' },
        'share_link_max_per_owner',
      ],
    ])('fails startup naming the key when %s', (_name, over, key) => {
      const found = startup(over);
      expect(found.length).toBeGreaterThan(0);
      expect(found.join(' ')).toContain(key);
    });

    it('fails when the code key equals the session-signing secret or the ad click secret, and never falls back to either', () => {
      expect(startup({ SHARE_LINK_CODE_KEY: JWT }).join(' ')).toMatch(
        /share_link_code_key must differ from jwt_secret/,
      );
      expect(startup({ SHARE_LINK_CODE_KEY: AD_SECRET }).join(' ')).toMatch(
        /share_link_code_key must differ from ads_click_secret/,
      );
      expect(startup({ SHARE_LINK_EDGE_SECRET: CODE_KEY }).join(' ')).toMatch(
        /share_link_code_key must differ from share_link_edge_secret|share_link_edge_secret must differ/,
      );
      // a configuration that supplies the old key and no code key does not start
      expect(
        startup(
          { SHARE_LINK_CODE_KEY: undefined },
          { ads_click_secret: AD_SECRET },
        ).join(' '),
      ).toContain('share_link_code_key');
    });

    it.each([
      ['http', 'http://shop.example'],
      ['carrying a path', 'https://shop.example/shop'],
      ['not a URL', 'shop.example'],
    ])(
      'fails when the storefront origin is %s, naming front_host',
      (_name, front) => {
        expect(startup({}, { front_host: front }).join(' ')).toContain(
          'front_host',
        );
      },
    );

    it('accepts http only for a localhost storefront', () => {
      expect(startup({}, { front_host: 'http://localhost:3000' })).toEqual([]);
    });
  });

  describe('S37 AS-63: metrics and logs', () => {
    let t: ShareLinksTestApp;
    let u1: TestUser;
    const MARKERS = {
      destinationPath: 'DESTPATH-8f3a',
      destinationQuery: 'DESTQUERY-91c2',
      referrer: 'referrer-marker.example',
      referrerPath: 'REFPATH-77d1',
      agent: 'UA-MARKER-4471',
      address: '198.51.100.23',
    };
    const metric = (name: string, labels: Record<string, string> = {}) =>
      MetricsRegistry.value(name, labels) ?? 0;

    beforeAll(async () => {
      t = await createShareLinksApp({ structuredLogger: true });
    });
    afterAll(async () => {
      await t.close();
    });
    beforeEach(async () => {
      await t.reset();
      u1 = await t.user();
    });

    it('the metrics match what was done', async () => {
      await t.rebuildFilter();
      const before = {
        generated: metric('link_created_total', { kind: 'generated' }),
        custom: metric('link_created_total', { kind: 'custom' }),
        redirected: metric('link_redirect_total', { outcome: 'redirected' }),
        notFound: metric('link_redirect_total', { outcome: 'not_found' }),
        gone: metric('link_redirect_total', { outcome: 'gone' }),
        unavailable: metric('link_redirect_total', { outcome: 'unavailable' }),
        reject: metric('link_resolve_total', { source: 'filter_reject' }),
        store: metric('link_resolve_total', { source: 'store' }),
        cache: metric('link_resolve_total', { source: 'cache' }),
        projected: metric('link_click_projected_total'),
        dead: metric('link_click_dead_lettered_total', {
          reason: 'ts_in_future',
        }),
        rejectedDestination: metric('link_destination_rejected_total'),
      };

      const generated = await t.newLink(u1);
      const alias = t.alias();
      await t
        .create(u1, { destination: t.destination(), alias })
        .then((r) => expect(r.status).toBe(201));
      await t.follow(generated); // store, redirected
      await t.follow(generated); // cache, redirected
      await t.follow('Zz9Zz9Z'); // filter reject, not found
      await t.as(u1).post(`/api/links/${alias}/disable`).expect(200);
      await t.follow(alias); // gone
      const lost = await t.plant({ code: t.alias('lost'), ownerId: u1.id });
      await t.rebuildFilter(); // the planted link was written without a filter entry
      t.faults.set('repo', { kind: 'down' });
      await t.follow(lost.code); // unavailable
      t.faults.clear();
      const hidden = await t.plant({
        code: t.alias('hidden'),
        ownerId: u1.id,
        destination: 'https://elsewhere.example/x',
      });
      await t.rebuildFilter();
      await t.follow(hidden.code); // destination rejected, gone

      const good = t.clickEvent(generated);
      const future = t.clickEvent(generated, {
        payload: {
          ts: new Date(t.clock.now().getTime() + 3_600_000).toISOString(),
        },
      });
      await t.projector.project([good as never]);
      await expect(
        t.projector.project([future as never]),
      ).rejects.toBeDefined();

      expect(metric('link_created_total', { kind: 'generated' })).toBe(
        before.generated + 1,
      );
      expect(metric('link_created_total', { kind: 'custom' })).toBe(
        before.custom + 1,
      );
      expect(metric('link_redirect_total', { outcome: 'redirected' })).toBe(
        before.redirected + 2,
      );
      expect(metric('link_redirect_total', { outcome: 'not_found' })).toBe(
        before.notFound + 1,
      );
      expect(metric('link_redirect_total', { outcome: 'gone' })).toBe(
        before.gone + 2,
      );
      expect(metric('link_redirect_total', { outcome: 'unavailable' })).toBe(
        before.unavailable + 1,
      );
      expect(metric('link_resolve_total', { source: 'filter_reject' })).toBe(
        before.reject + 1,
      );
      expect(metric('link_resolve_total', { source: 'cache' })).toBe(
        before.cache + 1,
      );
      expect(
        metric('link_resolve_total', { source: 'store' }),
      ).toBeGreaterThanOrEqual(before.store + 3);
      expect(metric('link_destination_rejected_total')).toBe(
        before.rejectedDestination + 1,
      );
      expect(metric('link_click_projected_total')).toBe(before.projected + 1);
      expect(
        metric('link_click_dead_lettered_total', { reason: 'ts_in_future' }),
      ).toBe(before.dead + 1);
      expect(MetricsRegistry.value('link_click_consumer_lag')).toBeDefined();
    });

    it('no log line, metric label or event field carries a destination, a referrer, a query, a secret or a visitor identifier', async () => {
      const destination = t.destination(
        `/p/${MARKERS.destinationPath}?q=${MARKERS.destinationQuery}`,
      );
      const code = await t.newLink(u1, { destination });
      const warn = t.producer; // the pipeline is broken for one visit so its warning is in the log, too
      warn('down');
      await t.follow(code, {
        referer: `https://${MARKERS.referrer}/${MARKERS.referrerPath}?x=1`,
        'user-agent': MARKERS.agent,
        'x-forwarded-for': MARKERS.address,
        'cf-ipcountry': 'DE',
      });
      await waitFor(async () =>
        t.rawLogs().includes('click event not published'),
      );
      t.producer(null);
      await t.follow(code, {
        referer: `https://${MARKERS.referrer}/${MARKERS.referrerPath}?x=1`,
        'user-agent': MARKERS.agent,
      });
      await waitFor(async () => t.eventsFor(code)[0]);

      const secrets = [
        t.config.get('share_link_code_key'),
        t.config.get('share_link_edge_secret'),
        t.config.get('jwt_secret'),
      ];
      const logged = t.rawLogs();
      for (const leaked of [
        MARKERS.destinationPath,
        MARKERS.destinationQuery,
        MARKERS.referrer,
        MARKERS.referrerPath,
        ...secrets,
      ])
        expect(logged).not.toContain(leaked);
      for (const event of t.published) {
        const text = JSON.stringify(event);
        for (const leaked of [
          ...Object.values(MARKERS).filter((m) => m !== MARKERS.referrer),
          ...secrets,
        ])
          expect(text).not.toContain(leaked);
      }

      const forbidden =
        /destination|referer|referrer|query|visitor|secret|userid|ip/i;
      for (const name of [
        'link_created_total',
        'link_redirect_total',
        'link_resolve_total',
        'link_filter_bypassed_total',
        'link_code_collision_total',
        'link_destination_rejected_total',
        'link_click_publish_failed_total',
        'link_click_projected_total',
        'link_click_dead_lettered_total',
        'link_click_consumer_lag',
      ])
        for (const labels of MetricsRegistry.labelSets(name))
          for (const [key, value] of Object.entries(labels)) {
            expect(key).not.toMatch(forbidden);
            expect(String(value)).not.toContain(code);
            expect(String(value)).not.toContain('shop.example');
          }
    });

    it('every warning the share-link code writes is one structured JSON line carrying the request id', async () => {
      const code = await t.newLink(u1);
      t.producer('down');
      await t.follow(code);
      await waitFor(async () =>
        t.rawLogs().includes('click event not published'),
      );
      const lines = t
        .logs()
        .filter((l) => /click event not published/.test(JSON.stringify(l)));
      expect(lines).toHaveLength(1);
      expect(JSON.stringify(lines[0])).toMatch(/requestId|request_id|reqId/);
    });
  });

  describe('S37 AS-64: boundaries', () => {
    const ROOT = join(__dirname, '..', '..', '..');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (name === 'node_modules' || name === 'dist') return [];
        return statSync(path).isDirectory() ? walk(path) : [path];
      });

    it('the barrel exports exactly the modules, the attribution lookup with its errors and the event contract', () => {
      expect(Object.keys(barrel).sort()).toEqual(
        [
          'AdsModule',
          'AdsProjectorModule',
          'AdsWorkerModule',
          'AttributionUnavailableError',
          // S36 sponsored listings: the event definitions (S32 consumes the sponsorship signal)
          'CampaignCreated',
          'CampaignEnded',
          'CampaignPaused',
          'CampaignResumed',
          'LinkAttributionModule',
          'LinkAttributionService',
          'ProductSponsorshipChanged',
          'ShareLinksModule',
          'ShareLinksProjectorModule',
          'ShareLinksWorkerModule',
          'TooManyCodesError',
          'linkClickedEventSchema',
        ].sort(),
      );
    });

    it('no other capability reaches into the share-link stores, keys, topic or analytics tables or deep-imports the domain', () => {
      const own = join(ROOT, 'libs', 'domains', 'marketing');
      const files = [
        ...walk(join(ROOT, 'libs')),
        ...walk(join(ROOT, 'apps')),
      ].filter(
        (f) =>
          /\.ts$/.test(f) &&
          !f.startsWith(own) &&
          !/\.(e2e-)?spec\.ts$/.test(f) &&
          !f.includes(`${join('libs', 'common', 'config')}`),
      );
      const needles = [
        /@app\/domains\/marketing\/(?!ads)/,
        /share-links:(id-seq|bloom)/,
        /link:v1:/,
        /\bFROM\s+link_clicks/i,
        /'Links'/,
        /links\.events/,
      ];
      const offenders = files.flatMap((file) => {
        const text = readFileSync(file, 'utf8');
        return needles
          .filter((needle) => needle.test(text))
          .map((needle) => `${relative(ROOT, file)}: ${needle}`);
      });
      expect(offenders).toEqual([]);
    });

    it('the domain layer reads no clock and imports no application or infrastructure code', () => {
      const domain = join(ROOT, 'libs', 'domains', 'marketing', 'domain');
      const offenders = walk(domain)
        // click-token.ts belongs to S36 (ads)
        .filter(
          (f) =>
            /\.ts$/.test(f) &&
            !/\.spec\.ts$/.test(f) &&
            !f.endsWith('click-token.ts'),
        )
        .flatMap((file) => {
          const text = readFileSync(file, 'utf8');
          return [
            /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)/,
            /from '\.\.\/(application|infra|api)\//,
          ]
            .filter((needle) => needle.test(text))
            .map((needle) => `${relative(ROOT, file)}: ${needle}`);
        });
      expect(offenders).toEqual([]);
    });
  });
});
