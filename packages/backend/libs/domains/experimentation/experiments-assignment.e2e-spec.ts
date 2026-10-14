import { assignmentsResponseSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import type { TestUser } from '@app/test/utils/catalog-app';
import { assign } from './domain/experiments';
import {
  EXPERIMENT_REPOSITORY,
  RUNNING_SET_CACHE,
  type ExperimentRepository,
  type RunningSetCache,
} from './domain/ports';
import {
  createAnalyticsApp,
  seedExperiment,
  truncateExperiments,
  type AnalyticsTestApp,
  type SeededExperiment,
} from './testing/analytics.fixtures';

const metric = (name: string, labels: Record<string, string> = {}): number =>
  MetricsRegistry.value(name, labels) ?? 0;

let addresses = 0;
const nextAddress = () =>
  `10.77.${(++addresses >> 8) & 255}.${addresses & 255}`;

const expected = (exp: SeededExperiment, unit: string) =>
  assign({ ...exp, key: exp.key }, unit);

interface Ask {
  user?: TestUser;
  anonymousId?: string;
  ip?: string;
}

describe('Experiment assignment API (S39)', () => {
  let t: AnalyticsTestApp;
  let runningSet: RunningSetCache;
  let repository: ExperimentRepository;

  const ask = (who: Ask = {}) => {
    let request = t
      .http()
      .get('/api/experiments/assignments')
      .set('X-Forwarded-For', who.ip ?? nextAddress());
    if (who.user) request = request.set('Authorization', who.user.bearer);
    if (who.anonymousId)
      request = request.set('X-Anonymous-Id', who.anonymousId);
    return request;
  };

  beforeAll(async () => {
    t = await createAnalyticsApp({ redisProxy: true });
    runningSet = t.app.get<RunningSetCache>(RUNNING_SET_CACHE);
    repository = t.app.get<ExperimentRepository>(EXPERIMENT_REPOSITORY);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await truncateExperiments(t.sequelize);
    await runningSet.invalidate();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    t.redisProxy!.mode = 'pass';
    await waitFor(async () => (await t.redis.ping()) === 'PONG', {
      description: 'redis back',
      timeoutMs: 15_000,
    });
  });

  describe('who is assigned', () => {
    it('S39 AS-20: a user experiment is assigned from the principal and a visitor experiment from a valid anonymous id', async () => {
      const user = await t.newUser();
      const userExp = await seedExperiment(t.sequelize, { unit: 'user' });
      const visitorExp = await seedExperiment(t.sequelize, { unit: 'visitor' });
      const anonymousId = 'anon-12345678';

      const both = await ask({ user, anonymousId });
      expect(both.status).toBe(200);
      expect(assignmentsResponseSchema.parse(both.body)).toEqual({
        assignments: {
          [userExp.key]: { variant: expected(userExp, user.id) },
          [visitorExp.key]: { variant: expected(visitorExp, anonymousId) },
        },
        degraded: false,
      });

      const visitorOnly = await ask({ anonymousId });
      expect(visitorOnly.body).toEqual({
        assignments: {
          [visitorExp.key]: { variant: expected(visitorExp, anonymousId) },
        },
        degraded: false,
      });

      const userOnly = await ask({ user });
      expect(userOnly.body).toEqual({
        assignments: { [userExp.key]: { variant: expected(userExp, user.id) } },
        degraded: false,
      });

      for (const invalid of [
        undefined,
        'short',
        'anon 12345678',
        'a'.repeat(65),
        'anon:12345678',
      ]) {
        const res = await ask({ anonymousId: invalid });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ assignments: {}, degraded: false });
      }
    });

    it('S39 AS-20: a signed-in caller gets its own user variant whatever anonymous id it sends', async () => {
      const user = await t.newUser();
      const userExp = await seedExperiment(t.sequelize, { unit: 'user' });
      const own = expected(userExp, user.id);
      // Another person's id, chosen so that its variant differs from the caller's own.
      let victim = '';
      for (let i = 0; i < 1_000 && !victim; i++) {
        const candidate = `victim-user-id-${i}-0000`;
        if (expected(userExp, candidate) !== own) victim = candidate;
      }
      expect(victim).not.toBe('');
      const res = await ask({ user, anonymousId: victim });
      expect(res.body.assignments[userExp.key]).toEqual({ variant: own });
      const anonymous = await ask({ anonymousId: victim });
      expect(anonymous.body.assignments).toEqual({});
    });

    it('S39 AS-21: draft and stopped experiments are not assigned', async () => {
      const draft = await seedExperiment(t.sequelize, { status: 'DRAFT' });
      const stopped = await seedExperiment(t.sequelize, {
        status: 'STOPPED',
        stoppedAt: new Date(),
      });
      const running = await seedExperiment(t.sequelize, { status: 'RUNNING' });
      const res = await ask({ anonymousId: 'anon-12345678' });
      expect(Object.keys(res.body.assignments)).toEqual([running.key]);
      expect(res.body.assignments).not.toHaveProperty(draft.key);
      expect(res.body.assignments).not.toHaveProperty(stopped.key);
    });

    it("S39 AS-20: an experiment outside the unit's layer range is not assigned", async () => {
      const narrow = await seedExperiment(t.sequelize, {
        layerFrom: 0,
        layerTo: 1,
      });
      const hits: boolean[] = [];
      for (let i = 0; i < 50; i++) {
        const id = `layer-probe-${i}-00000`;
        const res = await ask({ anonymousId: id });
        hits.push(narrow.key in res.body.assignments);
        expect(narrow.key in res.body.assignments).toBe(
          expected(narrow, id) !== null,
        );
      }
      expect(hits.filter(Boolean).length).toBeLessThan(5);
    });
  });

  describe('response', () => {
    it('S39 AS-22: the answer parses with its schema and is private, never shared-cached', async () => {
      const exp = await seedExperiment(t.sequelize);
      const res = await ask({ anonymousId: 'anon-12345678' });
      expect(res.status).toBe(200);
      const body = assignmentsResponseSchema.parse(res.body);
      expect(body.assignments[exp.key].variant).toBe(
        expected(exp, 'anon-12345678'),
      );
      expect(res.headers['cache-control']).toBe('private, no-store');
      // The platform's compression adds `Accept-Encoding` to the list; the two members that matter come first.
      expect(res.headers['vary']).toMatch(
        /^Authorization, X-Anonymous-Id(,|$)/,
      );
    });

    it('S39 AS-22: the 121st request in a minute from one caller is 429 with Retry-After', async () => {
      await seedExperiment(t.sequelize);
      // A fresh address per run: the limiter's window lives in Redis and outlives a previous run of this very spec.
      const ip = `10.99.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
      for (let i = 0; i < 120; i++) {
        const res = await ask({ anonymousId: 'anon-12345678', ip });
        if (res.status !== 200)
          throw new Error(`request ${i + 1}: ${res.status}`);
      }
      const limited = await ask({ anonymousId: 'anon-12345678', ip });
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
      expect((await ask({ anonymousId: 'anon-12345678' })).status).toBe(200);
    }, 120_000);
  });

  describe('stores down', () => {
    const cut = async () => {
      t.redisProxy!.mode = 'refuse';
      t.redisProxy!.sever();
      await waitFor(async () => t.redis.status !== 'ready', {
        description: 'redis client noticed the cut',
        timeoutMs: 5_000,
        intervalMs: 10,
      });
    };

    it('S39 AS-23: with the cache down the running set is read from the database and the answer is normal', async () => {
      const exp = await seedExperiment(t.sequelize);
      await cut();
      const res = await ask({ anonymousId: 'anon-12345678' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        assignments: { [exp.key]: { variant: expected(exp, 'anon-12345678') } },
        degraded: false,
      });
    });

    it('S39 AS-23: with the cache and the database both down the answer is 200 with nothing assigned, degraded, after 500 ms', async () => {
      await seedExperiment(t.sequelize);
      await cut();
      jest
        .spyOn(repository, 'listRunning')
        .mockImplementation(() => new Promise(() => undefined));
      const degraded = metric('experiment_assignments_total', {
        outcome: 'degraded',
      });
      const started = Date.now();
      const res = await ask({ anonymousId: 'anon-12345678' });
      const took = Date.now() - started;
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ assignments: {}, degraded: true });
      expect(took).toBeGreaterThanOrEqual(450);
      expect(took).toBeLessThan(3_000);
      expect(
        metric('experiment_assignments_total', { outcome: 'degraded' }),
      ).toBe(degraded + 1);
    });

    it('S39 AS-23: outcomes assigned and none are counted', async () => {
      const assigned = metric('experiment_assignments_total', {
        outcome: 'assigned',
      });
      const none = metric('experiment_assignments_total', { outcome: 'none' });
      await seedExperiment(t.sequelize);
      await ask({ anonymousId: 'anon-12345678' });
      await ask({});
      expect(
        metric('experiment_assignments_total', { outcome: 'assigned' }),
      ).toBe(assigned + 1);
      expect(metric('experiment_assignments_total', { outcome: 'none' })).toBe(
        none + 1,
      );
    });
  });
});

describe('Experiment assignment across two instances (S39)', () => {
  let a: AnalyticsTestApp;
  let b: AnalyticsTestApp;

  beforeAll(async () => {
    a = await createAnalyticsApp();
    b = await createAnalyticsApp();
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  const ask = (t: AnalyticsTestApp) =>
    t
      .http()
      .get('/api/experiments/assignments')
      .set('X-Forwarded-For', nextAddress())
      .set('X-Anonymous-Id', 'anon-12345678');

  it('S39 AS-24: a stopped experiment is no longer assigned by the instance that stopped it at once and by the other within 15 seconds', async () => {
    await truncateExperiments(a.sequelize);
    const exp = await seedExperiment(a.sequelize);
    const setA = a.app.get<RunningSetCache>(RUNNING_SET_CACHE);
    await setA.invalidate();
    await b.app.get<RunningSetCache>(RUNNING_SET_CACHE).invalidate();

    // Both instances serve and cache it.
    expect(Object.keys((await ask(a)).body.assignments)).toEqual([exp.key]);
    expect(Object.keys((await ask(b)).body.assignments)).toEqual([exp.key]);

    // The stop, as the command service leaves it: the row is stopped, then the writer invalidates after commit.
    await a.sequelize.query(
      `UPDATE "Experiment" SET "status" = 'STOPPED', "stoppedAt" = now(), "version" = "version" + 1 WHERE "key" = '${exp.key}'`,
    );
    await setA.invalidate();

    expect((await ask(a)).body.assignments).toEqual({});
    b.clock.advance(15_000);
    expect((await ask(b)).body).toEqual({ assignments: {}, degraded: false });
  });
});
