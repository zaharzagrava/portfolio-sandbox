import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  DuplicateTopicRouteError,
  RealtimePublisher,
  TopicRegistry,
} from '@app/infrastructure/realtime';
import { waitFor } from '@app/test/utils/async-helpers';
import type { TestUser } from '@app/test/utils/catalog-app';
import { FlagTopics } from './api/realtime-topics';
import type { FlagsClient } from './application/flags-client.service';
import { RedisRulesetPublisher } from './infra/redis-ruleset.publisher';
import { evalCountKey, RULESET_KEY } from './infra/redis-keys';
import {
  createFlagsApp,
  flagBody,
  rolloutRules,
  type FlagsTestApp,
} from './testing/flags.fixtures';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Flags local-evaluation SDK (S38)', () => {
  let t: FlagsTestApp;
  let admin: TestUser;
  let realtime: RealtimePublisher;

  beforeAll(async () => {
    t = await createFlagsApp();
    realtime = t.app.get(RealtimePublisher);
    // Every spec starts its own SDK (a "process"); the app's own one would also react to the snapshots fed below.
    await t.sdk.onModuleDestroy();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await t.admin();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await t.disposeSdks();
  });

  const users = (n: number) => Array.from({ length: n }, (_, i) => `user-${i}`);
  const share = (sdk: FlagsClient, key: string, n: number) =>
    users(n).filter((u) => sdk.isEnabled(key, { userId: u })).length / n;
  const snapshot = (version: number, flags: unknown[] = []) => ({
    version,
    flags,
  });
  const push = (version: number) =>
    realtime.publish('flags', 'ruleset', { version }, { replay: false });
  const breakCache = () =>
    jest.spyOn(t.redis, 'get').mockRejectedValue(new Error('cache down'));
  const breakDatabase = () =>
    jest
      .spyOn(t.repository, 'loadSnapshot')
      .mockRejectedValue(new Error('database down'));
  const breakPublish = () =>
    jest.spyOn(t.redis, 'eval').mockRejectedValue(new Error('cache down'));
  /** The push never reaches anyone (the publisher says it published). */
  const dropPush = () =>
    jest
      .spyOn(realtime, 'publish')
      .mockResolvedValue({ published: true, id: null });
  const converge = async (sdk: FlagsClient) => {
    const version = await t.rulesetVersion();
    await waitFor(async () => sdk.version >= version, {
      timeoutMs: 3_000,
      intervalMs: 20,
    });
  };

  describe('rollouts', () => {
    it('S38 AS-02: ramping to 5% puts 4–6% of 20,000 users on, stable across repeats and a restart, with an update audit row', async () => {
      const key = t.key('ramp');
      const sdk = await t.freshSdk();
      await t.create(admin, key, { enabled: false, rules: rolloutRules(5) });
      const saved = await t.put(
        admin,
        key,
        flagBody({
          enabled: true,
          rules: rolloutRules(5),
          expectedVersion: 1,
          owner: 'team-b',
        }),
      );
      expect(saved.status).toBe(200);
      await converge(sdk);

      const all = users(20_000);
      const on = all.filter((u) => sdk.isEnabled(key, { userId: u }));
      expect(on.length / all.length).toBeGreaterThan(0.04);
      expect(on.length / all.length).toBeLessThan(0.06);
      for (const u of on.slice(0, 50))
        for (let i = 0; i < 100; i++)
          expect(sdk.isEnabled(key, { userId: u })).toBe(true);

      const restarted = await t.freshSdk();
      expect(
        all.filter((u) => restarted.isEnabled(key, { userId: u })),
      ).toEqual(on);
      expect((await t.auditRows(key))[0]).toMatchObject({ action: 'update' });
    });

    it('S38 AS-14: a 50% rollout puts 45–55% of 2,000 users on and a fresh SDK loaded from the stores gives identical variants', async () => {
      const key = t.key('half');
      await t.create(admin, key, { enabled: true, rules: rolloutRules(50) });
      const sdk = await t.freshSdk();
      await converge(sdk);

      const share50 = share(sdk, key, 2_000);
      expect(share50).toBeGreaterThan(0.45);
      expect(share50).toBeLessThan(0.55);
      const other = await t.freshSdk();
      for (const u of users(2_000))
        expect(other.evaluate(key, { userId: u }).variant).toBe(
          sdk.evaluate(key, { userId: u }).variant,
        );
    });

    it('S38 AS-50: an expired flag keeps serving its rollout (expiry is advice, never evaluation)', async () => {
      const key = t.key('expiring');
      const expiresAt = new Date(
        t.clock.now().getTime() + 3_600_000,
      ).toISOString();
      await t.create(admin, key, {
        enabled: true,
        rules: rolloutRules(100),
        expiresAt,
      });
      const sdk = await t.freshSdk();
      await converge(sdk);
      expect(sdk.evaluate(key, { userId: 'u' })).toMatchObject({
        variant: 'on',
        reason: 'rollout',
      });

      t.clock.advance(2 * 3_600_000);

      expect(sdk.evaluate(key, { userId: 'u' })).toMatchObject({
        variant: 'on',
        reason: 'rollout',
      });
    });
  });

  describe('unknown flags and start-up', () => {
    it('S38 AS-17: unknown and archived keys evaluate to unknown_flag, isEnabled false and the caller fallback', async () => {
      const key = t.key('gone');
      await t.create(admin, key, { enabled: false });
      await t.post(admin, `/api/admin/flags/${key}/archive`).expect(204);
      const sdk = await t.freshSdk();
      await converge(sdk);

      for (const missing of [key, 'never-existed']) {
        expect(sdk.evaluate(missing, { userId: 'u' })).toMatchObject({
          key: missing,
          reason: 'unknown_flag',
          value: false,
        });
        expect(sdk.isEnabled(missing, { userId: 'u' })).toBe(false);
        expect(sdk.value(missing, { userId: 'u' }, 'fallback')).toBe(
          'fallback',
        );
        expect(sdk.value(missing, { userId: 'u' }, 7)).toBe(7);
      }
    });

    it('S38 AS-18: with both stores unreachable at run time 10,000 evaluations are identical, make zero client calls, and the process stays ready', async () => {
      const key = t.key('steady');
      await t.create(admin, key, { enabled: true, rules: rolloutRules(30) });
      const sdk = await t.freshSdk();
      await converge(sdk);
      const baseline = users(10_000).map((u) =>
        sdk.evaluate(key, { userId: u }),
      );

      const cache = breakCache();
      const database = breakDatabase();
      const eval_ = jest.spyOn(t.redis, 'eval');
      const during = users(10_000).map((u) => sdk.evaluate(key, { userId: u }));

      expect(during).toEqual(baseline);
      expect(cache).not.toHaveBeenCalled();
      expect(database).not.toHaveBeenCalled();
      expect(eval_).not.toHaveBeenCalled();
      expect(sdk.ready).toBe(true);
      const failures = metric('flags_refresh_failures_total');
      expect(await sdk.refresh('poll')).toBe(false);
      expect(sdk.ready).toBe(true);
      expect(sdk.evaluate(key, { userId: 'user-1' })).toEqual(baseline[1]);
      expect(metric('flags_refresh_failures_total')).toBe(failures + 1);
    });

    it('S38 AS-19: a cold start with an empty cache reads the database: ready, version equal to the database version', async () => {
      const key = t.key('cold');
      await t.create(admin, key, { enabled: true, rules: rolloutRules(100) });
      await t.redis.del(RULESET_KEY);

      const sdk = await t.freshSdk();

      expect(sdk.ready).toBe(true);
      expect(sdk.version).toBe(await t.rulesetVersion());
      expect(sdk.evaluate(key, { userId: 'u' }).variant).toBe('on');
    });

    it('S38 AS-20: a cold start with both stores down is not ready (ruleset_unavailable, fallbacks) yet the process starts, and loads within 5 s of recovery', async () => {
      const key = t.key('late');
      await t.create(admin, key, { enabled: true, rules: rolloutRules(100) });
      const cache = breakCache();
      const database = breakDatabase();

      const sdk = await t.freshSdk();

      expect(sdk.ready).toBe(false);
      expect(sdk.evaluate(key, { userId: 'u' })).toMatchObject({
        reason: 'ruleset_unavailable',
        value: false,
      });
      expect(sdk.value(key, { userId: 'u' }, 'fallback')).toBe('fallback');
      expect(sdk.isEnabled(key, { userId: 'u' })).toBe(false);

      cache.mockRestore();
      database.mockRestore();
      t.clock.advance(5_000);
      await sdk.tick();

      expect(sdk.ready).toBe(true);
      expect(sdk.evaluate(key, { userId: 'u' }).variant).toBe('on');
    });
  });

  describe('propagation', () => {
    it('S38 AS-21: a save and a kill reach a running SDK within 1 s', async () => {
      const key = t.key('pushed');
      const sdk = await t.freshSdk();
      await t.create(admin, key, { enabled: true, rules: rolloutRules(100) });
      await waitFor(
        async () => sdk.evaluate(key, { userId: 'u' }).variant === 'on',
        {
          timeoutMs: 1_000,
          intervalMs: 10,
        },
      );

      await t.post(admin, `/api/admin/flags/${key}/kill`).expect(204);

      await waitFor(
        async () => sdk.evaluate(key, { userId: 'u' }).reason === 'killed',
        {
          timeoutMs: 1_000,
          intervalMs: 10,
        },
      );
    });

    it('S38 AS-22: with the push lost, polling applies the change once 35 s have passed', async () => {
      const key = t.key('polled');
      const sdk = await t.freshSdk();
      dropPush();
      await t.create(admin, key, { enabled: true, rules: rolloutRules(100) });
      await new Promise((r) => setTimeout(r, 200));
      expect(sdk.evaluate(key, { userId: 'u' }).reason).toBe('unknown_flag');

      t.clock.advance(35_000);
      await sdk.tick();

      expect(sdk.evaluate(key, { userId: 'u' }).variant).toBe('on');
      expect(sdk.version).toBe(await t.rulesetVersion());
    });

    it('S38 AS-23: duplicate, older and reordered snapshots never move the SDK back; each ignored one is counted', async () => {
      const sdk = await t.freshSdk();
      const base = (await t.rulesetVersion()) + 100;
      const ignored = metric('flags_ruleset_ignored_total');
      const deliver = async (version: number, cacheVersion = version) => {
        await t.setCache(snapshot(cacheVersion));
        await push(version);
      };

      await deliver(base + 7);
      await waitFor(async () => sdk.version === base + 7, {
        timeoutMs: 2_000,
        intervalMs: 20,
      });
      await deliver(base + 6);
      await deliver(base + 7);
      await deliver(base + 7);
      await waitFor(
        async () => metric('flags_ruleset_ignored_total') === ignored + 3,
        {
          timeoutMs: 2_000,
          intervalMs: 20,
        },
      );
      expect(sdk.version).toBe(base + 7);

      await deliver(base + 8);
      await waitFor(async () => sdk.version === base + 8, {
        timeoutMs: 2_000,
        intervalMs: 20,
      });

      // a push of a newer version whose cache entry is still older is ignored too
      await deliver(base + 9, base + 6);
      await waitFor(
        async () => metric('flags_ruleset_ignored_total') === ignored + 4,
        {
          timeoutMs: 2_000,
          intervalMs: 20,
        },
      );
      expect(sdk.version).toBe(base + 8);
    });

    it('S38 AS-24: corrupt snapshots (bad JSON, schema-invalid) are rejected, the version is kept, the metric counts them and the next valid one is applied', async () => {
      const sdk = await t.freshSdk();
      const start = sdk.version;
      const rejected = metric('flags_ruleset_rejected_total');
      const base = start + 100;

      await t.setCache('{ this is not json');
      await push(base + 1);
      await waitFor(
        async () => metric('flags_ruleset_rejected_total') === rejected + 1,
        {
          timeoutMs: 2_000,
          intervalMs: 20,
        },
      );

      const badWeights = {
        key: 'broken',
        status: 'enabled',
        variants: [{ key: 'on', value: true }],
        defaultVariant: 'on',
        offVariant: 'on',
        rules: [
          {
            id: 'r',
            conditions: [],
            rollout: [{ variant: 'on', weight: 5_000 }],
          },
        ],
        bucketBy: 'userId',
        clientSide: false,
        version: 1,
      };
      await t.setCache(snapshot(base + 2, [badWeights]));
      await push(base + 2);
      await waitFor(
        async () => metric('flags_ruleset_rejected_total') === rejected + 2,
        {
          timeoutMs: 2_000,
          intervalMs: 20,
        },
      );
      expect(sdk.version).toBe(start);
      expect(sdk.evaluate('broken', {}).reason).toBe('unknown_flag');

      await t.setCache(snapshot(base + 3));
      await push(base + 3);
      await waitFor(async () => sdk.version === base + 3, {
        timeoutMs: 2_000,
        intervalMs: 20,
      });
    });

    it('S38 AS-27: a slow cache is cut at 500 ms, the database answers, and evaluation latency is unaffected meanwhile', async () => {
      const key = t.key('slow');
      const sdk = await t.freshSdk();
      breakPublish();
      await t.create(admin, key, { enabled: true, rules: rolloutRules(100) });
      jest.restoreAllMocks();
      expect(sdk.evaluate(key, { userId: 'u' }).reason).toBe('unknown_flag');
      const real = t.redis.get.bind(t.redis) as (
        k: string,
      ) => Promise<string | null>;
      jest
        .spyOn(t.redis, 'get')
        .mockImplementation(
          ((k: string) =>
            new Promise((resolve) =>
              setTimeout(() => resolve(real(k)), 1_500),
            )) as never,
        );

      const started = Date.now();
      const refresh = sdk.refresh('poll');
      const evalStart = process.hrtime.bigint();
      for (let i = 0; i < 1_000; i++) sdk.evaluate(key, { userId: `u${i}` });
      const evalMs = Number(process.hrtime.bigint() - evalStart) / 1e6;

      expect(evalMs).toBeLessThan(100);
      expect(await refresh).toBe(true);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(1_400);
      expect(sdk.evaluate(key, { userId: 'u' }).variant).toBe('on');
      expect(sdk.version).toBe(await t.rulesetVersion());
    });
  });

  describe('publishing and repair', () => {
    it('S38 AS-25: with the cache down a write still answers within 1.5 s, the rows are committed, the failure is counted and SDKs read the database at poll', async () => {
      const key = t.key('nocache');
      const sdk = await t.freshSdk();
      breakPublish();
      const failures = metric('flags_publish_failures_total');

      const started = Date.now();
      const res = await t.put(
        admin,
        key,
        flagBody({ enabled: true, rules: rolloutRules(100) }),
      );
      const took = Date.now() - started;

      expect(res.status).toBe(201);
      expect(took).toBeLessThan(1_500);
      expect(await t.flagRow(key)).toBeDefined();
      expect(await t.auditRows(key)).toHaveLength(1);
      expect(metric('flags_publish_failures_total')).toBe(failures + 1);
      expect(await t.cachedSnapshot()).toBeNull();

      jest.restoreAllMocks();
      t.clock.advance(35_000);
      await sdk.tick();
      expect(sdk.evaluate(key, { userId: 'u' }).variant).toBe('on');
    });

    describe('S38 AS-26: the repair job republishes a missing or older snapshot', () => {
      it('a missing snapshot is republished with a TTL', async () => {
        const key = t.key('lost');
        breakPublish();
        await t.create(admin, key, { enabled: true });
        jest.restoreAllMocks();
        expect(await t.cachedSnapshot()).toBeNull();

        expect(await t.repair.run()).toBe('republished');

        const cached = await t.cachedSnapshot();
        expect(cached?.version).toBe(await t.rulesetVersion());
        expect(cached?.flags.map((f) => f.key)).toContain(key);
        const ttl = await t.redis.ttl(RULESET_KEY);
        expect(ttl).toBeGreaterThan(3_500);
        expect(ttl).toBeLessThanOrEqual(3_600);
      });

      it('an older snapshot is replaced; an up-to-date one is left alone', async () => {
        await t.create(admin, t.key(), { enabled: true });
        const version = await t.rulesetVersion();
        await t.setCache(snapshot(version - 1));

        expect(await t.repair.run()).toBe('republished');
        expect((await t.cachedSnapshot())?.version).toBe(version);
        expect(await t.repair.run()).toBe('ok');
      });

      it('two concurrent runs republish once', async () => {
        breakPublish();
        await t.create(admin, t.key(), { enabled: true });
        jest.restoreAllMocks();
        const publish = jest.spyOn(t.app.get(RedisRulesetPublisher), 'publish');

        const [a, b] = await Promise.all([t.repair.run(), t.repair.run()]);

        expect([a, b]).toEqual(['republished', 'republished']);
        expect(publish).toHaveBeenCalledTimes(1);
      });

      it('survives the failure it repairs: a cache that errors is counted, never thrown', async () => {
        await t.create(admin, t.key(), { enabled: true });
        await t.redis.del(RULESET_KEY);
        breakCache();
        breakPublish();
        const failed = metric('flags_repair_total', { outcome: 'failed' });

        await expect(t.repair.run()).resolves.toBe('failed');

        expect(metric('flags_repair_total', { outcome: 'failed' })).toBe(
          failed + 1,
        );
        jest.restoreAllMocks();
        await expect(t.repair.run()).resolves.toBe('republished');
      });
    });

    it('S38 AS-28: after the cache is flushed the next save publishes the database version + 1, which the SDK applies', async () => {
      const sdk = await t.freshSdk();
      await t.create(admin, t.key(), { enabled: true });
      await converge(sdk);
      const before = await t.rulesetVersion();
      await t.redis.flushdb();
      expect(await t.cachedSnapshot()).toBeNull();

      const key = t.key('after-flush');
      await t.create(admin, key, { enabled: true, rules: rolloutRules(100) });

      const cached = await t.cachedSnapshot();
      expect(cached?.version).toBe(before + 1);
      expect(cached?.version).toBe(await t.rulesetVersion());
      await waitFor(async () => sdk.version === before + 1, {
        timeoutMs: 2_000,
        intervalMs: 20,
      });
      expect(sdk.evaluate(key, { userId: 'u' }).variant).toBe('on');
    });
  });

  describe('evaluation counters', () => {
    it('S38 AS-29: counts are flushed per frozen day, kept when a flush fails, and flushed at shutdown', async () => {
      const a = t.key('count-a');
      const b = t.key('count-b');
      await t.create(admin, a, { enabled: true, rules: rolloutRules(100) });
      await t.create(admin, b, { enabled: true, rules: rolloutRules(100) });
      const sdk = await t.freshSdk();
      await converge(sdk);
      t.clock.set(new Date('2026-03-05T10:00:00.000Z'));
      const key = evalCountKey('2026-03-05');
      const hash = async () => t.redis.hgetall(key);

      for (let i = 0; i < 3; i++) sdk.evaluate(a, { userId: 'u' });
      sdk.evaluate(b, { userId: 'u' });
      sdk.evaluate('not-in-the-ruleset', { userId: 'u' });
      await sdk.flushCounts();
      expect(await hash()).toEqual({ [a]: '3', [b]: '1' });
      const ttl = await t.redis.ttl(key);
      expect(ttl).toBeGreaterThan(39 * 86_400);
      expect(ttl).toBeLessThanOrEqual(40 * 86_400);

      sdk.evaluate(a, { userId: 'u' });
      sdk.evaluate(a, { userId: 'u' });
      const pipeline = jest
        .spyOn(t.redis, 'pipeline')
        .mockImplementation(() => {
          throw new Error('cache down');
        });
      await expect(sdk.flushCounts()).resolves.toBeUndefined();
      pipeline.mockRestore();
      expect(await hash()).toEqual({ [a]: '3', [b]: '1' });

      await sdk.flushCounts();
      expect(await hash()).toEqual({ [a]: '5', [b]: '1' });

      sdk.evaluate(a, { userId: 'u' });
      await sdk.onModuleDestroy();
      expect(await hash()).toEqual({ [a]: '6', [b]: '1' });
    });
  });

  it('S38 AS-58: metrics carry the exact values after a scripted sequence', async () => {
    const key = t.key('metered');
    await t.create(admin, key, { enabled: true, rules: rolloutRules(100) });
    const sdk = await t.freshSdk();
    await converge(sdk);
    const evals = metric('flags_evaluations_total', {
      flag: key,
      reason: 'rollout',
    });
    const unknown = metric('flags_evaluations_total', {
      flag: 'unknown',
      reason: 'unknown_flag',
    });
    const failures = metric('flags_refresh_failures_total');

    for (let i = 0; i < 3; i++) sdk.evaluate(key, { userId: `u${i}` });
    sdk.evaluate('made-up-by-a-caller', {});
    sdk.evaluate('another-made-up-key', {});
    await sdk.flushCounts();
    expect(
      metric('flags_evaluations_total', { flag: key, reason: 'rollout' }),
    ).toBe(evals + 3);
    expect(
      metric('flags_evaluations_total', {
        flag: 'unknown',
        reason: 'unknown_flag',
      }),
    ).toBe(unknown + 2);
    expect(
      MetricsRegistry.labelSets('flags_evaluations_total').map((l) => l.flag),
    ).not.toContain('made-up-by-a-caller');

    expect(metric('flags_ruleset_version')).toBe(sdk.version);
    t.clock.advance(10_000);
    await sdk.tick();
    expect(metric('flags_ruleset_age_seconds')).toBeGreaterThanOrEqual(10);
    expect(metric('flags_ruleset_age_seconds')).toBeLessThan(11);

    breakCache();
    breakDatabase();
    await sdk.refresh('poll');
    expect(metric('flags_refresh_failures_total')).toBe(failures + 1);
  });

  describe('S38 FR-024 realtime route (S51 follow-up)', () => {
    it('only a viewer with the SERVICE role may follow the flags topic, and defining the route twice throws DuplicateTopicRouteError', async () => {
      const registry = new TopicRegistry();
      const topics = new FlagTopics(registry);
      topics.onModuleInit();

      expect(
        await registry.canSubscribe(
          { userId: uuidv4(), roles: ['SERVICE'] },
          'flags',
        ),
      ).toBe(true);
      expect(
        await registry.canSubscribe(
          { userId: uuidv4(), roles: ['ADMIN'] },
          'flags',
        ),
      ).toBe(false);
      expect(await registry.canSubscribe({ userId: uuidv4() }, 'flags')).toBe(
        false,
      );
      expect(() => topics.onModuleInit()).toThrow(DuplicateTopicRouteError);
    });
  });
});
