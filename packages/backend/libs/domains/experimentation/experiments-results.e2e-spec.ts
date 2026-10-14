import { v4 as uuidv4 } from 'uuid';
import { experimentResultsSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import type { TestUser } from '@app/test/utils/catalog-app';
import { EVENT_STORE, type EventStore } from './domain/ports';
import {
  T0,
  applyAnalyticsStore,
  createAnalyticsApp,
  dropAnalyticsStream,
  freshAnalyticsTopic,
  insertRows,
  seedExperiment,
  storedRow,
  truncateAnalyticsStore,
  truncateExperiments,
  type AnalyticsTestApp,
  type SeededExperiment,
  type StoredRow,
} from './testing/analytics.fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;

type RowPatch = NonNullable<Parameters<typeof storedRow>[0]>;

const metric = (name: string, labels: Record<string, string> = {}): number =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Experiment results API (S39)', () => {
  let t: AnalyticsTestApp;
  let admin: TestUser;
  let store: EventStore;
  const STARTED = new Date(T0.getTime() - 2 * HOUR);

  /** A running `user`-unit purchase experiment started two hours before the frozen now. */
  const running = (patch: Partial<SeededExperiment> = {}) =>
    seedExperiment(t.sequelize, {
      key: `free-shipping-${uuidv4().slice(0, 8)}`,
      status: 'RUNNING',
      unit: 'user',
      metric: 'purchase',
      variants: [
        { key: 'control', weight: 5_000 },
        { key: 'free', weight: 5_000 },
      ],
      startedAt: STARTED,
      ...patch,
    });

  const results = (key: string, user: TestUser = admin) =>
    t.as(user).get(`/api/admin/experiments/${key}/results`);

  const exposure = (
    exp: SeededExperiment,
    unit: string,
    variant: string,
    ts: number,
    patch: RowPatch = {},
  ): StoredRow =>
    storedRow({
      name: 'exposure',
      ...(exp.unit === 'user'
        ? { user_id: unit, anonymous_id: `anon-of-${unit}`.padEnd(8, 'x') }
        : { anonymous_id: unit }),
      ts,
      received_at: ts + 1_000,
      props: { experiment: exp.key, variant },
      ...patch,
    });

  const event = (
    exp: SeededExperiment,
    name: string,
    unit: string,
    ts: number,
    patch: RowPatch = {},
  ): StoredRow =>
    storedRow({
      name,
      ...(exp.unit === 'user'
        ? {
            user_id: unit,
            anonymous_id:
              name === 'purchase' ? '' : `anon-of-${unit}`.padEnd(8, 'x'),
          }
        : { anonymous_id: unit }),
      platform: name === 'purchase' ? 'server' : 'web',
      ts,
      received_at: ts + 1_000,
      ...patch,
    });

  const users = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

  /** `exposures` units on `variant`, the first `converted` of which buy right after being exposed. */
  const arm = (
    exp: SeededExperiment,
    prefix: string,
    variant: string,
    exposures: number,
    converted: number,
  ): StoredRow[] =>
    users(exposures, prefix).flatMap((unit, i) => [
      exposure(exp, unit, variant, STARTED.getTime() + 10 * MIN + i),
      ...(i < converted
        ? [event(exp, exp.metric, unit, STARTED.getTime() + 20 * MIN + i)]
        : []),
    ]);

  beforeAll(async () => {
    await freshAnalyticsTopic();
    t = await createAnalyticsApp();
    await dropAnalyticsStream(t.clickhouse);
    await applyAnalyticsStore(t.clickhouse, { stream: true });
    store = t.app.get<EventStore>(EVENT_STORE);
  });
  afterAll(async () => {
    await dropAnalyticsStream(t.clickhouse);
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(T0);
    await truncateExperiments(t.sequelize);
    await truncateAnalyticsStore(t.clickhouse);
    admin = await t.admin();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('exposure', () => {
    it('S39 AS-25: an exposure sent to the collector counts its unit under the variant it names', async () => {
      const exp = await running({ unit: 'visitor', metric: 'page_view' });
      const anonymousId = `anon-as25-${uuidv4().slice(0, 8)}`;
      const sent = t.event({
        name: 'exposure',
        anonymous_id: anonymousId,
        ts: T0.getTime() - HOUR,
        props: { experiment: exp.key, variant: 'free' },
      });
      expect((await t.postEvents({ events: [sent] })).status).toBe(202);
      await waitFor(
        async () => (await store.readEvents([sent.event_id])).length === 1,
        {
          description: 'exposure stored',
          timeoutMs: 30_000,
        },
      );
      const res = await results(exp.key);
      expect(res.status).toBe(200);
      const body = experimentResultsSchema.parse(res.body);
      expect(
        body.variants.map((v) => [v.variant, v.exposures, v.conversions]),
      ).toEqual([
        ['control', 0, 0],
        ['free', 1, 0],
      ]);
    }, 60_000);

    it("S39 AS-26: a flag exposure is stored and never appears in an experiment's results", async () => {
      const exp = await running({
        unit: 'visitor',
        metric: 'page_view',
        key: 'new-checkout',
      });
      const anonymousId = `anon-as26-${uuidv4().slice(0, 8)}`;
      const flag = t.event({
        name: 'exposure',
        anonymous_id: anonymousId,
        ts: T0.getTime() - HOUR,
        props: { flag_key: 'new-checkout', variant: 'free', flag_version: '3' },
      });
      expect((await t.postEvents({ events: [flag] })).status).toBe(202);
      await waitFor(
        async () => (await store.readEvents([flag.event_id])).length === 1,
        {
          description: 'flag exposure stored',
          timeoutMs: 30_000,
        },
      );
      const body = experimentResultsSchema.parse((await results(exp.key)).body);
      expect(body.variants.map((v) => v.exposures)).toEqual([0, 0]);
      expect(body.excluded).toEqual({
        unattributable: 0,
        unknownVariant: 0,
        crossoverUnits: 0,
      });
    }, 60_000);

    it('S39 AS-27: ten exposures of one unit count once, at the first one', async () => {
      const exp = await running();
      const T = STARTED.getTime();
      const rows = [
        // u1: exposed ten times over an hour, buys 10 minutes after the first exposure
        ...Array.from({ length: 10 }, (_, i) =>
          exposure(exp, 'u1', 'control', T + 5 * MIN + i * 6 * MIN),
        ),
        event(exp, 'purchase', 'u1', T + 15 * MIN),
        // u2: buys before its first exposure
        event(exp, 'purchase', 'u2', T + 5 * MIN),
        ...Array.from({ length: 10 }, (_, i) =>
          exposure(exp, 'u2', 'control', T + 10 * MIN + i * 6 * MIN),
        ),
      ];
      await insertRows(t.clickhouse, rows);
      const body = experimentResultsSchema.parse((await results(exp.key)).body);
      expect(body.variants[0]).toMatchObject({
        variant: 'control',
        exposures: 2,
        conversions: 1,
      });
    });

    it('S39 AS-28: a unit exposed to two variants is a crossover: excluded from both and counted; over 1 % the readout is untrustworthy', async () => {
      const exp = await running();
      const T = STARTED.getTime();
      await insertRows(t.clickhouse, [
        ...arm(exp, 'ok-c', 'control', 150, 15),
        ...arm(exp, 'ok-f', 'free', 150, 15),
        exposure(exp, 'cross-1', 'control', T + 10 * MIN),
        exposure(exp, 'cross-1', 'free', T + 30 * MIN),
      ]);
      const small = experimentResultsSchema.parse(
        (await results(exp.key)).body,
      );
      expect(small.excluded.crossoverUnits).toBe(1);
      expect(small.variants.map((v) => v.exposures)).toEqual([150, 150]);
      expect(small.trustworthy).toBe(true);

      await insertRows(
        t.clickhouse,
        [2, 3, 4, 5].flatMap((n) => [
          exposure(exp, `cross-${n}`, 'control', T + 10 * MIN),
          exposure(exp, `cross-${n}`, 'free', T + 30 * MIN),
        ]),
      );
      // 300 counted units and 5 crossover units: 5 / 305 is above 1 %.
      const big = experimentResultsSchema.parse((await results(exp.key)).body);
      expect(big.excluded.crossoverUnits).toBe(5);
      expect(big.trustworthy).toBe(false);
      expect(big.problems).toEqual(['crossover_exceeds_threshold']);
      expect(big.variants[1].comparison).toBe('withheld_untrustworthy');
    });

    it('S39 AS-29: an unknown variant, an exposure outside the window and an exposure of an unknown experiment are left out without touching the rest', async () => {
      const exp = await running();
      const T = STARTED.getTime();
      await insertRows(t.clickhouse, [
        ...arm(exp, 'known', 'control', 120, 12),
        ...arm(exp, 'known-f', 'free', 120, 12),
        exposure(exp, 'known-0', 'ghost', T + 40 * MIN), // a known unit also exposed to an unknown variant: stays in control
        exposure(exp, 'ghost-user', 'ghost', T + 40 * MIN),
        exposure(exp, 'before', 'control', T - MIN), // before startedAt
        exposure(exp, 'after', 'control', T + 3 * HOUR), // after the read time
        exposure(
          { ...exp, key: 'other-experiment' },
          'elsewhere',
          'control',
          T + 10 * MIN,
        ),
      ]);
      const body = experimentResultsSchema.parse((await results(exp.key)).body);
      expect(body.variants.map((v) => v.exposures)).toEqual([120, 120]);
      expect(body.excluded).toEqual({
        unattributable: 0,
        unknownVariant: 2,
        crossoverUnits: 0,
      });
    });
  });

  describe('numbers', () => {
    it('S39 AS-42: 10,000 users per variant, 1,000 and 1,200 buyers: every field of the readout', async () => {
      const exp = await running();
      await insertRows(t.clickhouse, [
        ...arm(exp, 'ctl', 'control', 10_000, 1_000),
        ...arm(exp, 'frd', 'free', 10_000, 1_200),
      ]);
      const res = await results(exp.key);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = experimentResultsSchema.parse(res.body);
      expect(body).toMatchObject({
        experiment: exp.key,
        version: 1,
        status: 'running',
        metric: 'purchase',
        unit: 'user',
        analysis: 'fixed_horizon',
        windowStart: STARTED.toISOString(),
        windowEnd: T0.toISOString(),
        asOf: T0.toISOString(),
        alpha: 0.05,
        trustworthy: true,
        problems: [],
        srm: { chiSquare: 0, pValue: 1, mismatch: false },
        excluded: { unattributable: 0, unknownVariant: 0, crossoverUnits: 0 },
      });
      expect(body.variants[0]).toEqual({
        variant: 'control',
        exposures: 10_000,
        conversions: 1_000,
        conversionRate: 0.1,
        comparison: 'control',
      });
      expect(body.variants[1]).toMatchObject({
        variant: 'free',
        exposures: 10_000,
        conversions: 1_200,
        conversionRate: 0.12,
        comparison: 'available',
      });
      const vs = body.variants[1].vsControl!;
      expect(vs.absoluteDifference).toBeCloseTo(0.02, 10);
      expect(vs.relativeLift).toBeCloseTo(0.2, 10);
      expect(vs.pValue).toBeLessThan(0.001);
      expect(Math.abs(vs.zScore)).toBeGreaterThan(4);
      expect(vs.confidenceInterval95[0]).toBeLessThan(0.02);
      expect(vs.confidenceInterval95[1]).toBeGreaterThan(0.02);
      expect(vs.significant).toBe(true);
      expect(
        metric('experiment_results_total', { trustworthy: 'true' }),
      ).toBeGreaterThanOrEqual(1);
    }, 120_000);

    it('S39 AS-43: a purchase before the first exposure, one after the experiment stopped, and a second purchase of one unit do not count extra', async () => {
      const stoppedAt = new Date(T0.getTime() - HOUR);
      const exp = await running({ status: 'STOPPED', stoppedAt });
      const T = STARTED.getTime();
      const end = stoppedAt.getTime();
      await insertRows(t.clickhouse, [
        exposure(exp, 'twice', 'control', T + 10 * MIN),
        event(exp, 'purchase', 'twice', T + 20 * MIN),
        event(exp, 'purchase', 'twice', T + 25 * MIN),
        exposure(exp, 'early', 'control', T + 30 * MIN),
        event(exp, 'purchase', 'early', T + 5 * MIN),
        exposure(exp, 'late', 'control', T + 40 * MIN),
        event(exp, 'purchase', 'late', end + 5 * MIN),
        exposure(exp, 'at-exposure', 'control', T + 50 * MIN),
        event(exp, 'purchase', 'at-exposure', T + 50 * MIN),
        exposure(exp, 'at-end', 'control', T + 55 * MIN),
        event(exp, 'purchase', 'at-end', end),
      ]);
      const body = experimentResultsSchema.parse((await results(exp.key)).body);
      expect(body.windowEnd).toBe(stoppedAt.toISOString());
      expect(body.variants[0]).toMatchObject({ exposures: 5, conversions: 3 });
    });

    it('S39 AS-44: rows duplicated across unmerged parts give the numbers of the de-duplicated data', async () => {
      const exp = await running();
      const rows = [
        ...arm(exp, 'dup-c', 'control', 300, 30),
        ...arm(exp, 'dup-f', 'free', 300, 45),
      ];
      await insertRows(t.clickhouse, rows);
      const once = experimentResultsSchema.parse((await results(exp.key)).body);
      await insertRows(
        t.clickhouse,
        rows.map((row, i) => ({
          ...row,
          received_at: new Date(
            Date.parse(`${row.received_at.replace(' ', 'T')}Z`) + HOUR + i,
          )
            .toISOString()
            .replace('T', ' ')
            .replace('Z', ''),
        })),
      );
      await insertRows(t.clickhouse, rows);
      const raw = await t.clickhouse.getClient().query({
        query: `SELECT count() AS n FROM analytics_event_log`,
        format: 'JSONEachRow',
      });
      expect(Number((await raw.json<{ n: string }>())[0].n)).toBe(
        rows.length * 3,
      );
      const thrice = experimentResultsSchema.parse(
        (await results(exp.key)).body,
      );
      expect(thrice).toEqual(once);
      expect(thrice.variants.map((v) => v.exposures)).toEqual([300, 300]);
    });

    it('S39 AS-45: a 6,000/4,000 split on a 50/50 experiment is a sample ratio mismatch and withholds the comparison', async () => {
      const exp = await running();
      await insertRows(t.clickhouse, [
        ...arm(exp, 'srm-c', 'control', 6_000, 600),
        ...arm(exp, 'srm-f', 'free', 4_000, 600),
      ]);
      const mismatch = experimentResultsSchema.parse(
        (await results(exp.key)).body,
      );
      expect(mismatch.srm.mismatch).toBe(true);
      expect(mismatch.srm.pValue).toBeLessThan(0.001);
      expect(mismatch.trustworthy).toBe(false);
      expect(mismatch.problems).toEqual(['srm_mismatch']);
      expect(mismatch.variants[1].comparison).toBe('withheld_untrustworthy');
      expect(mismatch.variants[1]).not.toHaveProperty('vsControl');
      expect(metric('experiment_srm_mismatch_total')).toBeGreaterThanOrEqual(1);
    }, 120_000);

    it('S39 AS-45: 5,030 against 4,970 is not a mismatch', async () => {
      const exp = await running();
      await insertRows(t.clickhouse, [
        ...arm(exp, 'ok-c', 'control', 5_030, 500),
        ...arm(exp, 'ok-f', 'free', 4_970, 600),
      ]);
      const body = experimentResultsSchema.parse((await results(exp.key)).body);
      expect(body.srm.mismatch).toBe(false);
      expect(body.trustworthy).toBe(true);
      expect(body.variants[1].comparison).toBe('available');
    }, 120_000);

    it('S39 AS-46: an arm of 99 units makes the comparison insufficient_sample while counts and rates are shown', async () => {
      const exp = await running();
      await insertRows(t.clickhouse, [
        ...arm(exp, 'few-c', 'control', 99, 9),
        ...arm(exp, 'few-f', 'free', 99, 20),
      ]);
      const body = experimentResultsSchema.parse((await results(exp.key)).body);
      expect(body.variants[1]).toMatchObject({
        exposures: 99,
        conversions: 20,
        comparison: 'insufficient_sample',
      });
      expect(body.variants[1]).not.toHaveProperty('vsControl');
      expect(body.variants[1].conversionRate).toBeCloseTo(20 / 99, 10);
    });

    it('S39 AS-47: three variants are tested at 0.025', async () => {
      const exp = await running({
        variants: [
          { key: 'control', weight: 3_400 },
          { key: 'a', weight: 3_300 },
          { key: 'b', weight: 3_300 },
        ],
      });
      await insertRows(t.clickhouse, [
        ...arm(exp, 'x-c', 'control', 340, 34),
        ...arm(exp, 'x-a', 'a', 330, 40),
        ...arm(exp, 'x-b', 'b', 330, 33),
      ]);
      const body = experimentResultsSchema.parse((await results(exp.key)).body);
      expect(body.alpha).toBe(0.025);
      expect(body.variants.map((v) => v.comparison)).toEqual([
        'control',
        'available',
        'available',
      ]);
    });
  });

  describe('units', () => {
    it('S39 AS-49: a user experiment counts only events with a user id; a visitor experiment keys every event by the anonymous id', async () => {
      const T = STARTED.getTime();
      const userExp = await running({ unit: 'user', metric: 'page_view' });
      await insertRows(t.clickhouse, [
        exposure(userExp, 'signed-in', 'control', T + 10 * MIN),
        storedRow({
          name: 'exposure',
          user_id: '',
          anonymous_id: 'anon-only-visitor',
          ts: T + 10 * MIN,
          props: { experiment: userExp.key, variant: 'control' },
        }),
        storedRow({
          name: 'exposure',
          user_id: '',
          anonymous_id: 'anon-only-visitor-2',
          ts: T + 11 * MIN,
          props: { experiment: userExp.key, variant: 'free' },
        }),
      ]);
      const forUser = experimentResultsSchema.parse(
        (await results(userExp.key)).body,
      );
      expect(forUser.variants.map((v) => v.exposures)).toEqual([1, 0]);
      expect(forUser.excluded.unattributable).toBe(2);

      const visitorExp = await running({
        unit: 'visitor',
        metric: 'page_view',
      });
      await insertRows(t.clickhouse, [
        // a signed-in visitor: counted by the anonymous id, not the user id
        storedRow({
          name: 'exposure',
          user_id: 'signed-in-user',
          anonymous_id: 'anon-of-signed-in',
          ts: T + 10 * MIN,
          props: { experiment: visitorExp.key, variant: 'control' },
        }),
        storedRow({
          name: 'page_view',
          user_id: 'signed-in-user',
          anonymous_id: 'anon-of-signed-in',
          ts: T + 20 * MIN,
        }),
        storedRow({
          name: 'exposure',
          user_id: '',
          anonymous_id: 'anon-only-visitor',
          ts: T + 10 * MIN,
          props: { experiment: visitorExp.key, variant: 'free' },
        }),
      ]);
      const forVisitor = experimentResultsSchema.parse(
        (await results(visitorExp.key)).body,
      );
      expect(
        forVisitor.variants.map((v) => [v.exposures, v.conversions]),
      ).toEqual([
        [1, 1],
        [1, 0],
      ]);
      expect(forVisitor.excluded.unattributable).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('S39 AS-50: a draft and a running experiment without exposures answer 200 with zero counts and no_data', async () => {
      const draft = await seedExperiment(t.sequelize, {
        status: 'DRAFT',
        unit: 'user',
        metric: 'purchase',
      });
      const empty = await running();
      for (const [exp, status] of [
        [draft, 'draft'],
        [empty, 'running'],
      ] as const) {
        const res = await results(exp.key);
        expect(res.status).toBe(200);
        const body = experimentResultsSchema.parse(res.body);
        expect(body.status).toBe(status);
        expect(
          body.variants.map((v) => [v.exposures, v.conversions, v.comparison]),
        ).toEqual([
          [0, 0, 'control'],
          [0, 0, 'no_data'],
        ]);
        expect(body.srm).toEqual({ chiSquare: 0, pValue: 1, mismatch: false });
      }
      expect(
        experimentResultsSchema.parse((await results(draft.key)).body)
          .windowStart,
      ).toBeNull();
    });

    it('S39 AS-50: an unknown key is 404 not_found and an anonymous caller 401', async () => {
      const missing = await results('no-such-experiment');
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('not_found');
      const anonymous = await t
        .http()
        .get('/api/admin/experiments/no-such-experiment/results');
      expect(anonymous.status).toBe(401);
    });

    it('S39 AS-52: an event that reaches the store after the stop is counted when its event time is inside the window, and one after stoppedAt is not', async () => {
      const stoppedAt = new Date(T0.getTime() - HOUR);
      const exp = await running({ status: 'STOPPED', stoppedAt });
      const T = STARTED.getTime();
      const end = stoppedAt.getTime();
      await insertRows(t.clickhouse, [
        exposure(exp, 'late-arrival', 'control', T + 10 * MIN),
        exposure(exp, 'too-late', 'control', T + 10 * MIN),
      ]);
      const before = experimentResultsSchema.parse(
        (await results(exp.key)).body,
      );
      expect(before.variants[0]).toMatchObject({
        exposures: 2,
        conversions: 0,
      });
      // Arrives now (after the stop) with an event time inside the window / after the window.
      await insertRows(t.clickhouse, [
        event(exp, 'purchase', 'late-arrival', end - 10 * MIN, {
          received_at: T0.getTime(),
        }),
        event(exp, 'purchase', 'too-late', end + 10 * MIN, {
          received_at: T0.getTime(),
        }),
      ]);
      const after = experimentResultsSchema.parse(
        (await results(exp.key)).body,
      );
      expect(after.variants[0]).toMatchObject({ exposures: 2, conversions: 1 });
    });
  });

  describe('failures', () => {
    it('S39 AS-51: a store that is down is 503 analytics_store_unavailable with Retry-After, no numbers, and counted', async () => {
      const exp = await running();
      await insertRows(t.clickhouse, arm(exp, 'down', 'control', 5, 1));
      const errors = metric('analytics_store_errors_total', {
        operation: 'results',
      });
      jest
        .spyOn(t.clickhouse.getClient(), 'query')
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const res = await results(exp.key);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('analytics_store_unavailable');
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body.variants).toBeUndefined();
      expect(
        metric('analytics_store_errors_total', { operation: 'results' }),
      ).toBe(errors + 1);
      // The next read works: the failure leaves nothing behind.
      expect((await results(exp.key)).status).toBe(200);
    });

    it('S39 AS-51: a store that does not answer within 10 seconds is the same 503', async () => {
      const exp = await running();
      const errors = metric('analytics_store_errors_total', {
        operation: 'results',
      });
      jest
        .spyOn(t.clickhouse.getClient(), 'query')
        .mockImplementationOnce(() => new Promise(() => undefined));
      const started = Date.now();
      const res = await results(exp.key);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('analytics_store_unavailable');
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_500);
      expect(
        metric('analytics_store_errors_total', { operation: 'results' }),
      ).toBe(errors + 1);
    }, 30_000);

    it('S39 AS-53: the 21st read of results in a minute is 429; other admins are unaffected', async () => {
      const exp = await running();
      const busy = await t.admin();
      for (let i = 0; i < 20; i++) {
        const res = await results(exp.key, busy);
        if (res.status !== 200) throw new Error(`read ${i + 1}: ${res.status}`);
      }
      const limited = await results(exp.key, busy);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect((await results(exp.key, await t.admin())).status).toBe(200);
    }, 60_000);
  });
});
