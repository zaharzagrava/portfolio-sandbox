import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { QueryTypes } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { INGEST_CODES } from '@marketplace-sandbox/contracts';
import { OrderPaid } from '@app/domains/orders';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { OWNERSHIP, ownedBy } from '../../../db/ownership';
import { AnalyticsProjectorModule } from './analytics-projector.module';
import { AnalyticsWorkerModule } from './analytics-worker.module';
import { StoreDeadLetterWatcher } from './application/store-dead-letter-watcher.service';
import {
  EXPERIMENT_REPOSITORY,
  RUNNING_SET_CACHE,
  type ExperimentRepository,
  type RunningSetCache,
} from './domain/ports';
import { PurchaseEventsProjector } from './infra/purchase-events.projector';
import {
  T0,
  applyAnalyticsStore,
  chTime,
  createAnalyticsApp,
  freshAnalyticsTopic,
  insertRows,
  seedExperiment,
  storedRow,
  truncateAnalyticsStore,
  truncateExperiments,
  type AnalyticsTestApp,
} from './testing/analytics.fixtures';

const run = promisify(execFile);
const HOUR = 3_600_000;

const metric = (name: string, labels: Record<string, string> = {}): number =>
  MetricsRegistry.value(name, labels) ?? 0;

/** Values of the closed label sets, so a series that carries anything else is a leak. */
const CLOSED: Record<string, Record<string, readonly string[]>> = {
  analytics_events_total: {
    outcome: ['accepted', 'rejected', 'duplicate_in_batch'],
    reason: ['ok', ...INGEST_CODES],
  },
  analytics_ingest_requests_total: {
    status: ['202', '400', '401', '403', '413', '415', '429', '500', '503'],
  },
  analytics_dead_letter_total: { source: ['store', 'purchase-projector'] },
  experiment_assignments_total: { outcome: ['assigned', 'none', 'degraded'] },
  experiment_results_total: { trustworthy: ['true', 'false'] },
  analytics_store_errors_total: { operation: ['results', 'dead-letter-poll'] },
  analytics_produce_failures_total: {},
  analytics_rate_limited_total: {},
  analytics_rate_limiter_degraded_total: {},
  experiment_srm_mismatch_total: {},
};

describe('Analytics operations: metrics, logs, ownership (S39)', () => {
  describe('metrics', () => {
    let t: AnalyticsTestApp;
    let repository: ExperimentRepository;
    let runningSet: RunningSetCache;

    beforeAll(async () => {
      await freshAnalyticsTopic();
      t = await createAnalyticsApp({
        redisProxy: true,
        extraImports: [AnalyticsProjectorModule, AnalyticsWorkerModule],
      });
      await applyAnalyticsStore(t.clickhouse);
      repository = t.app.get<ExperimentRepository>(EXPERIMENT_REPOSITORY);
      runningSet = t.app.get<RunningSetCache>(RUNNING_SET_CACHE);
    });
    afterAll(async () => {
      await t.close();
    });
    beforeEach(async () => {
      t.clock.set(T0);
      await truncateExperiments(t.sequelize);
      await truncateAnalyticsStore(t.clickhouse);
      await runningSet.invalidate();
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('S39 AS-54: every counter of the capability matches what the traffic did, with closed label values', async () => {
      const series = (name: string, labels: Record<string, string>) => ({
        name,
        labels,
        before: metric(name, labels),
      });
      const watch = [
        series('analytics_events_total', { outcome: 'accepted', reason: 'ok' }),
        series('analytics_events_total', {
          outcome: 'rejected',
          reason: 'invalid_page',
        }),
        series('analytics_events_total', {
          outcome: 'rejected',
          reason: 'unknown_event_name',
        }),
        series('analytics_events_total', {
          outcome: 'duplicate_in_batch',
          reason: 'duplicate_in_batch',
        }),
        series('analytics_ingest_requests_total', { status: '202' }),
        series('analytics_ingest_requests_total', { status: '400' }),
        series('analytics_ingest_requests_total', { status: '413' }),
        series('analytics_ingest_requests_total', { status: '415' }),
        series('analytics_ingest_requests_total', { status: '503' }),
        series('analytics_ingest_requests_total', { status: '429' }),
        series('analytics_produce_failures_total', {}),
        series('analytics_rate_limited_total', {}),
        series('analytics_dead_letter_total', { source: 'store' }),
        series('analytics_dead_letter_total', { source: 'purchase-projector' }),
        series('experiment_assignments_total', { outcome: 'assigned' }),
        series('experiment_assignments_total', { outcome: 'none' }),
        series('experiment_assignments_total', { outcome: 'degraded' }),
        series('experiment_results_total', { trustworthy: 'true' }),
        series('experiment_results_total', { trustworthy: 'false' }),
        series('experiment_srm_mismatch_total', {}),
        series('analytics_store_errors_total', { operation: 'results' }),
      ];
      const delta = (name: string, labels: Record<string, string>) =>
        metric(name, labels) -
        watch.find(
          (s) =>
            s.name === name &&
            JSON.stringify(s.labels) === JSON.stringify(labels),
        )!.before;

      // --- ingest: 3 accepted, 1 bad page, 1 unknown name, 1 duplicate; then the envelope and body failures ---
      const first = t.event();
      const ok = await t.postEvents({
        events: [
          first,
          t.event(),
          t.event(),
          { ...first },
          t.event({ page: '/'.repeat(501) }),
          t.event({ name: 'login' }),
        ],
      });
      expect(ok.status).toBe(202);
      expect((await t.postEvents({ events: [] })).status).toBe(400);
      expect(
        (
          await t.postEvents({
            events: [t.event()],
            pad: 'x'.repeat(130 * 1024),
          })
        ).status,
      ).toBe(413);
      expect(
        (
          await t.postEvents(undefined, {
            contentType: 'application/xml',
            raw: '<x/>',
          })
        ).status,
      ).toBe(415);
      jest
        .spyOn(t.producer, 'sendMany')
        .mockRejectedValueOnce(new Error('broker down'));
      expect((await t.postEvents({ events: [t.event()] })).status).toBe(503);
      const limited = await t.newUser();
      for (let i = 0; i < 120; i++)
        await t.postEvents(
          { events: [t.event({ name: 'nope' })] },
          { user: limited },
        );
      expect(
        (await t.postEvents({ events: [t.event()] }, { user: limited })).status,
      ).toBe(429);

      // --- assignments: assigned, none, degraded ---
      await seedExperiment(t.sequelize, { unit: 'visitor' });
      const ask = (id?: string) => {
        const request = t
          .http()
          .get('/api/experiments/assignments')
          .set(
            'X-Forwarded-For',
            `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
          );
        return id ? request.set('X-Anonymous-Id', id) : request;
      };
      expect((await ask('anon-ops-12345678')).status).toBe(200);
      expect((await ask()).status).toBe(200);
      await runningSet.invalidate();
      jest
        .spyOn(repository, 'listRunning')
        .mockRejectedValueOnce(new Error('db down'));
      expect((await ask('anon-ops-12345678')).body.degraded).toBe(true);

      // --- results: a trustworthy readout, a mismatch, a store failure ---
      const admin = await t.admin();
      const exp = await seedExperiment(t.sequelize, {
        unit: 'visitor',
        metric: 'page_view',
        startedAt: new Date(T0.getTime() - 2 * HOUR),
      });
      const results = () =>
        t.as(admin).get(`/api/admin/experiments/${exp.key}/results`);
      expect((await results()).body.trustworthy).toBe(true);
      await insertRows(
        t.clickhouse,
        Array.from({ length: 300 }, (_, i) =>
          storedRow({
            name: 'exposure',
            anonymous_id: `ops-anon-${i}-xxxxxxxx`,
            ts: T0.getTime() - HOUR,
            props: { experiment: exp.key, variant: 'control' },
          }),
        ),
      );
      const mismatch = await results();
      expect(mismatch.body.srm.mismatch).toBe(true);
      expect(mismatch.body.trustworthy).toBe(false);
      jest
        .spyOn(t.clickhouse.getClient(), 'query')
        .mockRejectedValueOnce(new Error('store down'));
      expect((await results()).status).toBe(503);

      // --- dead letters: one from the purchase projector, one the store wrote into its error table ---
      const projector = t.app.get(PurchaseEventsProjector, { strict: false });
      const template = OrderPaid.create(uuidv4(), 1, {
        orderId: uuidv4(),
        userId: 'u',
        orderVersion: 1,
        totalMinor: 1,
        currency: 'usd',
        paymentRef: 'p',
        paidAt: T0.toISOString(),
        lines: [],
        shopOrders: [],
      } as never);
      await projector.project([
        { ...template, payload: { ...template.payload, totalMinor: 'x' } },
      ]);
      const watcher = t.app.get(StoreDeadLetterWatcher, { strict: false });
      await watcher.poll();
      await t.clickhouse.getClient().insert({
        table: 'analytics_events_errors',
        values: [
          {
            raw: '{bad',
            error: 'cannot parse',
            topic: 'analytics.events',
            partition: 0,
            offset: 1,
          },
        ],
        format: 'JSONEachRow',
      });
      expect(await watcher.poll()).toBe(1);

      expect({
        accepted: delta('analytics_events_total', {
          outcome: 'accepted',
          reason: 'ok',
        }),
        invalidPage: delta('analytics_events_total', {
          outcome: 'rejected',
          reason: 'invalid_page',
        }),
        unknownName: delta('analytics_events_total', {
          outcome: 'rejected',
          reason: 'unknown_event_name',
        }),
        duplicate: delta('analytics_events_total', {
          outcome: 'duplicate_in_batch',
          reason: 'duplicate_in_batch',
        }),
        // 120 requests of one invalid event each count as rejected too, but not under these reasons
        status202: delta('analytics_ingest_requests_total', { status: '202' }),
        status400: delta('analytics_ingest_requests_total', { status: '400' }),
        status413: delta('analytics_ingest_requests_total', { status: '413' }),
        status415: delta('analytics_ingest_requests_total', { status: '415' }),
        status503: delta('analytics_ingest_requests_total', { status: '503' }),
        status429: delta('analytics_ingest_requests_total', { status: '429' }),
        produceFailures: delta('analytics_produce_failures_total', {}),
        rateLimited: delta('analytics_rate_limited_total', {}),
        deadLetterStore: delta('analytics_dead_letter_total', {
          source: 'store',
        }),
        deadLetterProjector: delta('analytics_dead_letter_total', {
          source: 'purchase-projector',
        }),
        assigned: delta('experiment_assignments_total', {
          outcome: 'assigned',
        }),
        none: delta('experiment_assignments_total', { outcome: 'none' }),
        degraded: delta('experiment_assignments_total', {
          outcome: 'degraded',
        }),
        trusted: delta('experiment_results_total', { trustworthy: 'true' }),
        untrusted: delta('experiment_results_total', { trustworthy: 'false' }),
        srm: delta('experiment_srm_mismatch_total', {}),
        storeErrors: delta('analytics_store_errors_total', {
          operation: 'results',
        }),
      }).toEqual({
        accepted: 3,
        invalidPage: 1,
        unknownName: 1 + 120, // the 120 requests of the rate-limit run each sent one event named "nope"
        duplicate: 1,
        status202: 1 + 120,
        status400: 1,
        status413: 1,
        status415: 1,
        status503: 1,
        status429: 1,
        produceFailures: 1,
        rateLimited: 1,
        deadLetterStore: 1,
        deadLetterProjector: 1,
        assigned: 1,
        none: 1,
        degraded: 1,
        trusted: 1,
        untrusted: 1,
        srm: 1,
        storeErrors: 1,
      });

      for (const [name, closed] of Object.entries(CLOSED))
        for (const labels of MetricsRegistry.labelSets(name)) {
          expect(Object.keys(labels).sort()).toEqual(
            Object.keys(closed).sort(),
          );
          for (const [label, value] of Object.entries(labels))
            expect(closed[label]).toContain(String(value));
        }
    }, 180_000);
  });

  describe('logs', () => {
    let t: AnalyticsTestApp;

    beforeAll(async () => {
      await freshAnalyticsTopic();
      t = await createAnalyticsApp({ structuredLogger: true });
      await applyAnalyticsStore(t.clickhouse);
    });
    afterAll(async () => {
      await t.close();
    });
    beforeEach(async () => {
      t.clock.set(T0);
      await truncateExperiments(t.sequelize);
    });

    it('S39 AS-55: ingest, assignment and admin requests log JSON with a request id and never props values, user ids, tokens or a full anonymous id', async () => {
      const buyer = await t.newUser();
      const admin = await t.admin();
      const anonymousId = `anon-secret-${uuidv4().slice(0, 12)}`;
      const marker = `PROPS-VALUE-${uuidv4()}`;
      // Setting up the callers writes identity's own audit lines (they name the user by design): look from here on.
      const setupLines = t.logs().length;

      await t.postEvents(
        {
          events: [
            t.event({ anonymous_id: anonymousId, props: { note: marker } }),
            t.event({
              anonymous_id: anonymousId,
              page: '/'.repeat(501),
              props: { note: marker },
            }),
          ],
        },
        { user: buyer },
      );
      const exp = await seedExperiment(t.sequelize, { unit: 'visitor' });
      await t
        .http()
        .get('/api/experiments/assignments')
        .set('Authorization', buyer.bearer)
        .set('X-Anonymous-Id', anonymousId);
      const key = `ops-log-${uuidv4().slice(0, 8)}`;
      const created = await t
        .as(admin)
        .put(`/api/admin/experiments/${key}`)
        .send({
          expectedVersion: 0,
          description: '',
          owner: 'growth',
          unit: 'visitor',
          variants: [
            { key: 'control', weight: 5_000 },
            { key: 'b', weight: 5_000 },
          ],
          layer: `log-${uuidv4().slice(0, 8)}`,
          layerFrom: 0,
          layerTo: 100,
          metric: 'click',
        });
      expect(created.status).toBe(201);
      await t.as(admin).post(`/api/admin/experiments/${key}/start`).expect(200);
      await t.as(admin).get(`/api/admin/experiments/${key}/results`);

      const lines = t.logs().slice(setupLines);
      expect(lines.length).toBeGreaterThan(0);
      const text = lines.map((l) => JSON.stringify(l));
      const ours = lines.filter((l) =>
        JSON.stringify(l).match(/analytics\.|experiments\./),
      );
      expect(ours.length).toBeGreaterThanOrEqual(3);
      for (const line of ours) expect(typeof line.requestId).toBe('string');
      expect(ours.map((l) => l.event ?? l.msg)).toEqual(
        expect.arrayContaining(['analytics.ingest', 'experiments.changed']),
      );
      for (const forbidden of [
        marker,
        buyer.id,
        admin.id,
        buyer.bearer.replace(/^Bearer /, ''),
        admin.bearer.replace(/^Bearer /, ''),
        anonymousId,
      ])
        expect(text.filter((line) => line.includes(forbidden))).toEqual([]);
      void exp;
    }, 60_000);
  });

  describe('ownership', () => {
    it('S39 AS-56: the tables of the capability are registered to experimentation and exist', async () => {
      expect(OWNERSHIP.Experiment).toBe('domain:experimentation');
      expect(OWNERSHIP.ExperimentAudit).toBe('domain:experimentation');
      expect(ownedBy('domain:experimentation')).toEqual(
        expect.arrayContaining(['Experiment', 'ExperimentAudit']),
      );
      const t = await createAnalyticsApp();
      try {
        for (const table of ['Experiment', 'ExperimentAudit']) {
          const [row] = await t.sequelize.query<{ found: boolean }>(
            `SELECT to_regclass('"${table}"') IS NOT NULL AS "found"`,
            { type: QueryTypes.SELECT },
          );
          expect({ table, found: row.found }).toEqual({ table, found: true });
        }
      } finally {
        await t.close();
      }
    });

    it('S39 AS-56: the static gates report nothing for experimentation', async () => {
      const ownership = await run('pnpm', ['check:table-ownership'], {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      }).catch((error) => error as { stdout: string; stderr: string });
      expect(`${ownership.stdout}${ownership.stderr}`).not.toMatch(
        /experimentation/i,
      );
      await expect(
        run('pnpm', ['check:boundaries'], {
          cwd: process.cwd(),
          maxBuffer: 10 * 1024 * 1024,
        }),
      ).resolves.toBeDefined();
    }, 300_000);
  });
});

void chTime;
