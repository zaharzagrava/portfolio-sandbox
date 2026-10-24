import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { boundaryCheck, ownershipCheck } from '@app/test/utils/static-checks';
import { FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { KAFKA_CONSUMER_OVERRIDES } from '@app/infrastructure/kafka/kafka-client.options';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import * as barrel from './index';
import {
  aggregateKey,
  correctionMergeKey,
  mergeKey,
  seenKey,
} from './infra/trending-keys';
import {
  countRedisCommands,
  createProjectorOnly,
  createTrendingApp,
  createTrendingTopic,
  deleteTrendingTopics,
  sleep,
  storedEvent,
  waitFor,
  windowOf,
  type TrendingTestApp,
} from './testing/trending.fixtures';

const BACKEND = join(__dirname, '..', '..', '..');
const RETENTION_SECONDS = 10_800;

const counter = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

describe('Trending degradation, metrics and boundary', () => {
  afterAll(() => deleteTrendingTopics());

  describe('metrics, retention and configuration', () => {
    let t: TrendingTestApp;
    beforeAll(async () => {
      t = await createTrendingApp({ redisProxy: true });
    });
    afterAll(() => t.close());
    beforeEach(() => t.clean());
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('S35 AS-36: every instrument exists with fixed-enum labels, the merge timestamp moves, and logs and labels carry no identifiers', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const error = jest.spyOn(Logger.prototype, 'error');
      const mergedBefore = counter('trending_last_merge_timestamp_seconds');
      // The gauge counts whole seconds: wait for the next second, so a merge made at once is strictly later than this reading.
      await waitFor(
        () => Promise.resolve(Math.floor(Date.now() / 1000) > mergedBefore),
        { description: 'the next second' },
      );
      const d = await t.seedDatasetT();
      await t.produce([
        'not json',
        Buffer.from('{"x":1}'),
        storedEvent({ name: 'page_view', productId: d.A.id, at: '12:06:10' }),
      ]);
      await t.settle();
      await t
        .http()
        .get('/api/trending')
        .query({ category: 'audio' })
        .expect(200);
      await t.http().get('/api/trending').query({ limit: '0' }).expect(400);
      t.redisProxy!.mode = 'refuse';
      await t
        .http()
        .get('/api/trending')
        .query({ category: 'cameras' })
        .expect(503);
      t.redisProxy!.mode = 'pass';

      for (const outcome of ['counted', 'ignored', 'invalid'])
        expect(counter('trending_events_total', { outcome })).toBeGreaterThan(
          0,
        );
      expect(counter('trending_windows_closed_total')).toBeGreaterThan(0);
      expect(
        counter('trending_merges_total', { outcome: 'merged' }),
      ).toBeGreaterThan(0);
      expect(counter('trending_last_merge_timestamp_seconds')).toBeGreaterThan(
        mergedBefore,
      );
      for (const outcome of ['ok', 'invalid', 'unavailable'])
        expect(counter('trending_requests_total', { outcome })).toBeGreaterThan(
          0,
        );
      expect(
        counter('trending_dependency_failures_total', {
          dependency: 'aggregate',
        }),
      ).toBeGreaterThan(0);
      for (const result of ['miss'])
        expect(
          counter('trending_ranking_cache_total', { result }),
        ).toBeGreaterThan(0);
      for (const gauge of [
        'trending_oldest_unmerged_window_age_seconds',
        'trending_consumer_lag',
        'trending_tracked_bytes',
      ])
        expect({ gauge, v: MetricsRegistry.value(gauge) }).toEqual({
          gauge,
          v: expect.any(Number),
        });

      // labels are fixed enums, never an id or a category
      const allowed: Record<string, string[]> = {
        trending_events_total: ['outcome'],
        trending_merges_total: ['outcome'],
        trending_requests_total: ['outcome'],
        trending_dependency_failures_total: ['dependency'],
        trending_ranking_cache_total: ['result'],
      };
      for (const [name, keys] of Object.entries(allowed))
        for (const labels of MetricsRegistry.labelSets(name))
          expect(Object.keys(labels)).toEqual(keys);
      const labelText = JSON.stringify(
        Object.keys(allowed).map((n) => MetricsRegistry.labelSets(n)),
      );
      const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
      for (const secret of [d.A.id, d.B.id, d.shopId, 'audio', 'cameras']) {
        expect(labelText).not.toContain(secret);
        expect(logged).not.toContain(secret);
      }
      expect(logged).not.toContain('"x":1');
    });

    it('S35 AS-39: every stored key has a TTL within the retention, names equal the key helpers, the read touches only the horizon keys and never scans', async () => {
      const d = await t.seedDatasetT();
      const window = windowOf('12:01');
      const stored = await t.keys();
      expect(stored).toEqual(
        expect.arrayContaining([
          aggregateKey('all', window),
          aggregateKey('audio', window),
          mergeKey(0, window),
        ]),
      );
      for (const key of stored) {
        const ttl = await t.ttl(key);
        expect({ key, ttl: ttl > 0 && ttl <= RETENTION_SECONDS }).toEqual({
          key,
          ttl: true,
        });
      }
      const shapes = [
        /^trending:\{[a-z0-9-]+\}:\d+$/,
        /^trending:merge:\d+:\d+(:c:\d+-\d+)?$/,
        /^trending:seen:[^:]+$/,
        /^trending:v1:/,
      ];
      for (const key of stored)
        expect({ key, ok: shapes.some((s) => s.test(key)) }).toEqual({
          key,
          ok: true,
        });
      expect(correctionMergeKey(0, window, 3, 9)).toBe(
        `trending:merge:0:${window}:c:3-9`,
      );
      expect(seenKey('e1')).toBe('trending:seen:e1');

      const spy = countRedisCommands();
      try {
        await t
          .http()
          .get('/api/trending')
          .query({ category: 'audio' })
          .expect(200);
        expect(spy.unions).toBe(1);
        expect(spy.commands['keys'] ?? 0).toBe(0);
        expect(spy.commands['scan'] ?? 0).toBe(0);
      } finally {
        spy.stop();
      }
      // the union names exactly the 60 horizon aggregates of the category
      const sent: string[][] = [];
      const original = t.redis.client.call.bind(t.redis.client);
      jest.spyOn(t.redis.client, 'call').mockImplementation(((
        name: string,
        ...args: string[]
      ) => {
        if (name.toLowerCase() === 'zunion') sent.push(args);
        return original(name, ...args);
      }) as never);
      const cached = await t.keys('trending:v1:*');
      if (cached.length > 0) await t.redis.client.del(...cached);
      await t
        .http()
        .get('/api/trending')
        .query({ category: 'audio' })
        .expect(200);
      expect(sent).toHaveLength(1);
      const keys = sent[0].slice(1, 1 + Number(sent[0][0]));
      expect(keys).toHaveLength(60);
      expect(keys.every((k) => k.startsWith('trending:{audio}:'))).toBe(true);
      expect(d.A.id).toBeDefined();
    });

    it('S35 AS-37: starting with one invalid TRENDING_ value fails and names the key', async () => {
      await expect(
        createTrendingApp({ env: { TRENDING_HEAP_K: '10' } }),
      ).rejects.toThrow(/trending_heap_k/i);
      await expect(
        createTrendingApp({ env: { TRENDING_ALL_WIDTH: '1000' } }),
      ).rejects.toThrow(/trending_all_width/i);
    });
  });

  describe('module boundary', () => {
    it('S35 AS-38: the entry point exports only the two modules; application and api import nothing from infra', () => {
      const names = Object.keys(barrel).filter((n) => /Trending/.test(n));
      expect(names.sort()).toEqual([
        'TrendingModule',
        'TrendingProjectorModule',
      ]);
      const forbidden = /from '(\.\.\/)+infra\/|from '\.\.\/infra\//;
      for (const dir of ['application', 'api']) {
        for (const file of walk(join(__dirname, dir)).filter(
          (f) =>
            /trending/.test(f) && f.endsWith('.ts') && !f.endsWith('spec.ts'),
        )) {
          const src = readFileSync(file, 'utf8');
          expect({ file, infra: forbidden.test(src) }).toEqual({
            file,
            infra: false,
          });
          expect({
            file,
            model: /ProductModel|sequelize\.transaction/.test(src),
          }).toEqual({
            file,
            model: false,
          });
        }
      }
    });

    it('S35 AS-38: the static boundary checks report nothing for trending', async () => {
      // the two checks do not depend on each other: run them side by side
      const [boundaries, ownership] = await Promise.all([
        boundaryCheck(BACKEND),
        ownershipCheck(BACKEND, ['--strict'], true),
      ]);
      expect(boundaries.status).toBe(0);
      // other domains may still carry findings (exit 1); the report must hold no line for trending
      expect(ownership.stdout).toMatch(/\S/);
      expect(ownership.stdout.toLowerCase()).not.toMatch(/trending/);
    }, 400_000);
  });

  describe('consumer lifecycle', () => {
    let proxy: TcpFaultProxy;
    beforeAll(async () => {
      proxy = await TcpFaultProxy.start({ host: 'localhost', port: 9192 });
    });
    afterAll(() => proxy.close());

    it('S35 AS-40: a broker that is down at start keeps the consumer not ready, counts failures and retries; it becomes ready when the broker returns', async () => {
      const topic = await createTrendingTopic();
      proxy.mode = 'refuse';
      const failuresBefore = counter(
        'trending_consumer_connect_failures_total',
      );
      const p = await createProjectorOnly({
        topic,
        groupId: `trending-down-${Date.now()}`,
        env: { TRENDING_CONNECT_TIMEOUT_MS: '1000' },
        overrides: [
          {
            provide: KAFKA_CONSUMER_OVERRIDES,
            useValue: { socketFactory: proxy.kafkaSocketFactory() },
          },
        ],
      });
      try {
        await waitFor(
          () =>
            Promise.resolve(
              counter('trending_consumer_connect_failures_total') >
                failuresBefore + 1,
            ),
          { description: 'connect failures counted', timeoutMs: 30_000 },
        );
        const readiness = p.app.get(ReadinessService, { strict: false });
        await expect(readinessOf(readiness, p.clock)).resolves.toBe(false);
        expect(p.exits).toEqual([]);

        proxy.mode = 'pass';
        await p.consumer.whenReady();
        await expect(readinessOf(readiness, p.clock)).resolves.toBe(true);
      } finally {
        proxy.mode = 'pass';
        await p.close();
      }
    }, 90_000);

    it('S35 AS-40: a dead loop turns readiness off and ends the process through the injected exit', async () => {
      const topic = await createTrendingTopic();
      proxy.mode = 'pass';
      const p = await createProjectorOnly({
        topic,
        groupId: `trending-crash-${Date.now()}`,
        overrides: [
          {
            provide: KAFKA_CONSUMER_OVERRIDES,
            useValue: { socketFactory: proxy.kafkaSocketFactory() },
          },
        ],
      });
      try {
        await p.consumer.whenReady();
        const readiness = p.app.get(ReadinessService, { strict: false });
        await expect(readinessOf(readiness, p.clock)).resolves.toBe(true);
        // the group stops answering for good: the consumer loop ends and the process must not run on
        proxy.mode = 'refuse';
        proxy.sever();
        await waitFor(() => Promise.resolve(p.exits.length > 0), {
          description: 'process exit called',
          timeoutMs: 60_000,
        });
        expect(p.exits[0]).toBe(1);
        await expect(readinessOf(readiness, p.clock)).resolves.toBe(false);
      } finally {
        proxy.mode = 'pass';
        await sleep(50);
        await p.close();
      }
    }, 120_000);
  });
});

async function readinessOf(
  readiness: ReadinessService,
  clock: FakeClock,
): Promise<boolean> {
  // the probe caches for 2 s of its clock; move the frozen clock past it so each call reads the current state
  clock.advance(2_100);
  const report = await readiness.report();
  return report.checks['trending-consumer'] === 'up' && report.ready;
}
