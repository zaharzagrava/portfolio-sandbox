import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ApiConfigService } from '@app/common/config';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import * as discovery from '@app/domains/discovery';
import {
  closeNodes,
  createAutocompleteApp,
  type AutocompleteTestApp,
} from './testing/autocomplete-app';

const BACKEND = join(__dirname, '../../..');
const run = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, {
    cwd: BACKEND,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', TS_NODE_TRANSPILE_ONLY: '1' },
    maxBuffer: 32 * 1024 * 1024,
  });

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels);

describe('Autocomplete module boundary, metrics and configuration', () => {
  describe('boundary (AS-49)', () => {
    it('S33 AS-49: the boundary and table-ownership checks are clean and the barrel exports the two autocomplete modules only', () => {
      const boundaries = run('npx', [
        'depcruise',
        'apps',
        'libs',
        'test',
        'db',
        '--config',
        '.dependency-cruiser.cjs',
        '--output-type',
        'err',
      ]);
      expect(boundaries.stdout + boundaries.stderr).toContain(
        'no dependency violations found',
      );

      const ownership = run('node', [
        '-r',
        'ts-node/register',
        'scripts/check-table-ownership.ts',
        '--strict',
      ]);
      // other domains still carry cross-domain reads (their debt); discovery must carry none
      const output = ownership.stdout + ownership.stderr;
      expect(output).toContain('cross-domain data accesses');
      expect(output).not.toMatch(/libs\/domains\/discovery\//);
      expect(output).not.toMatch(/^discovery\s+\(/m);

      const exported = Object.keys(discovery).filter((name) =>
        // `ProductTitleSuggester` and its timeout error are S32's public surface, not autocomplete's
        /autocomplete|suggestservice|queryindex|snapshot|trie|circuit/i.test(
          name,
        ),
      );
      expect(exported.sort()).toEqual(
        ['AutocompleteModule', 'AutocompleteWorkerModule'].sort(),
      );
    }, 240_000);
  });

  describe('metrics (AS-50)', () => {
    let t: AutocompleteTestApp;
    beforeAll(async () => {
      t = await createAutocompleteApp();
    });
    afterAll(() => closeNodes(t));

    it('S33 AS-50: after each kind of traffic the listed series exist and no label holds query text', async () => {
      await t.resetSearch();
      await t.resetAutocomplete();
      await t.logQuery('metrics probe lamp', 6);
      const okBefore =
        metric('autocomplete_requests_total', { status: 'ok' }) ?? 0;
      const invalidBefore =
        metric('autocomplete_requests_total', { status: 'invalid' }) ?? 0;
      const degradedBefore =
        metric('autocomplete_requests_total', { status: 'degraded' }) ?? 0;

      expect((await t.publish()).outcome).toBe('published');
      await t.suggest('metrics');
      await t
        .http()
        .get('/api/suggest')
        .query({ q: 'x'.repeat(101) })
        .expect(400);
      await t.index.refresh(); // a poll with nothing new
      // a node without a snapshot is degraded
      await t.resetAutocomplete();
      const bare = await createAutocompleteApp();
      try {
        await bare.suggest('metrics');
      } finally {
        await bare.app.close().catch(() => undefined);
      }

      expect(
        metric('autocomplete_requests_total', { status: 'ok' }),
      ).toBeGreaterThan(okBefore);
      expect(metric('autocomplete_requests_total', { status: 'invalid' })).toBe(
        invalidBefore + 1,
      );
      expect(
        metric('autocomplete_requests_total', { status: 'degraded' }),
      ).toBeGreaterThan(degradedBefore);
      expect(
        metric('autocomplete_degraded_total', {
          reason: 'query_index_unavailable',
        }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        metric('autocomplete_builds_total', { outcome: 'published' }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        MetricsRegistry.histogramValue('autocomplete_source_duration_seconds', {
          source: 'query',
        })?.count,
      ).toBeGreaterThanOrEqual(1);
      expect(metric('autocomplete_circuit_state')).toBeDefined();
      expect(metric('autocomplete_snapshot_age_seconds')).toBeDefined();
      expect(metric('autocomplete_snapshot_version')).toBeDefined();

      const labelled = [
        'autocomplete_requests_total',
        'autocomplete_degraded_total',
        'autocomplete_source_duration_seconds',
        'autocomplete_builds_total',
        'autocomplete_snapshot_load_failures_total',
      ];
      for (const name of labelled)
        for (const labels of MetricsRegistry.labelSets(name))
          for (const value of Object.values(labels))
            expect([name, String(value)]).toEqual([
              name,
              expect.not.stringMatching(/metrics|probe|lamp|xxx/i),
            ]);
    });
  });

  describe('configuration (AS-51)', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    });
    const boot = () => new ApiConfigService(new ConfigUtilsService()).init();

    it.each([
      [
        'autocomplete_catalog_budget_ms',
        'AUTOCOMPLETE_CATALOG_BUDGET_MS',
        ['0', '-5', 'abc', '1001'],
      ],
      [
        'autocomplete_typo_budget_ms',
        'AUTOCOMPLETE_TYPO_BUDGET_MS',
        ['0', 'abc'],
      ],
      ['autocomplete_k', 'AUTOCOMPLETE_K', ['0', '101', 'abc']],
      ['autocomplete_depth', 'AUTOCOMPLETE_DEPTH', ['0', '101']],
      ['autocomplete_min_searchers', 'AUTOCOMPLETE_MIN_SEARCHERS', ['0', '-1']],
      ['autocomplete_window_days', 'AUTOCOMPLETE_WINDOW_DAYS', ['0', '91']],
      ['autocomplete_cap', 'AUTOCOMPLETE_CAP', ['0', 'abc']],
      ['autocomplete_poll_ms', 'AUTOCOMPLETE_POLL_MS', ['0', 'abc']],
      [
        'autocomplete_retention_count',
        'AUTOCOMPLETE_RETENTION_COUNT',
        ['0', '-2'],
      ],
      [
        'autocomplete_log_query_timeout_ms',
        'AUTOCOMPLETE_LOG_QUERY_TIMEOUT_MS',
        ['0', '600000'],
      ],
      [
        'autocomplete_blocklist',
        'AUTOCOMPLETE_BLOCKLIST',
        ['fake,,hack', 'two words,fake'],
      ],
    ] as const)(
      'S33 AS-51: %s with an invalid value fails startup naming the key and not the value',
      async (key, variable, bad) => {
        for (const value of bad) {
          process.env[variable] = value;
          const failure = await boot().then(
            () => null,
            (error: Error) => error,
          );
          expect([variable, value, failure?.message ?? '']).toEqual([
            variable,
            value,
            expect.stringContaining(key),
          ]);
        }
      },
    );

    it('S33 AS-51: valid values start, and the defaults apply when nothing is set', async () => {
      process.env.AUTOCOMPLETE_K = '7';
      process.env.AUTOCOMPLETE_BLOCKLIST = 'fake,scam';
      const config = new ApiConfigService(new ConfigUtilsService());
      await config.init();
      expect(config.get('autocomplete_k')).toBe(7);
      expect(config.get('autocomplete_blocklist')).toBe('fake,scam');

      for (const key of Object.keys(process.env))
        if (key.startsWith('AUTOCOMPLETE_')) delete process.env[key];
      const defaults = new ApiConfigService(new ConfigUtilsService());
      await defaults.init();
      expect(defaults.get('autocomplete_catalog_budget_ms')).toBe(40);
      expect(defaults.get('autocomplete_k')).toBe(10);
      expect(defaults.get('autocomplete_window_days')).toBe(30);
      expect(defaults.get('autocomplete_cap')).toBe(200_000);
      expect(defaults.get('autocomplete_blocklist')).toBe(
        'fake,counterfeit,stolen,hack,hacked',
      );
    });
  });
});
