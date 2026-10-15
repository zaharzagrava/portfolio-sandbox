import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { BreakerStore, DeliveryLog } from './domain/webhook-ports';
import { WebhookWorkers } from './infra/webhook-workers';
import {
  createWebhookKit,
  type WebhookKit,
  type WebhookReceiver,
  type WebhookWorld,
} from './testing/webhook-e2e.fixture';
import { createFlow, type Flow } from './testing/webhook-flow';
import { clearRateLimits } from './testing/public-api-kit';
import { WebhooksProjectorModule } from './webhooks-projector.module';
import { WebhooksWorkerModule } from './webhooks-worker.module';

const DISABLED = 'developerplatform.webhook_endpoint_disabled';
const CHANGED = 'developerplatform.webhook_endpoint_changed';
const SEC = 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('Webhooks: auto-disable, shop lifecycle and retention', () => {
  let queue: InMemoryTaskQueue;
  let t: WebhookKit;
  let flow: Flow;
  let w: WebhookWorld;
  let schedulesAtBoot: object[] = [];

  beforeAll(async () => {
    queue = new InMemoryTaskQueue();
    t = await createWebhookKit({
      structuredLogger: true,
      extraImports: [WebhooksProjectorModule, WebhooksWorkerModule],
      overrides: [{ provide: TaskQueue, useValue: queue }],
    });
    flow = createFlow(t, queue);
    // `t.reset()` empties the schedule table, so what the worker registered at boot is read once, before the first reset.
    schedulesAtBoot = await t.rows(
      `SELECT name, "jobType", overlap, enabled FROM "JobSchedule" WHERE name LIKE 'webhooks.%' ORDER BY name`,
    );
  }, 120_000);
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await clearRateLimits(t.app);
    queue.sent.length = 0;
    w = await t.seedWorld();
  });

  const log = () => t.app.get(DeliveryLog, { strict: false });
  const breaker = () => t.app.get(BreakerStore, { strict: false });
  const workers = () => t.app.get(WebhookWorkers);
  /** The scheduled sweep, as the job runner invokes it. */
  const sweep = () => workers().disableFailingEndpoints();

  const setup = async (
    world: WebhookWorld = w,
    path = '/in',
  ): Promise<{
    receiver: WebhookReceiver;
    e: { id: string; secret: string };
  }> => {
    const receiver = await t.startReceiver();
    const e = await flow.endpoint(world, receiver.url(path));
    return { receiver, e };
  };
  const row = async (id: string) =>
    (
      await t.rows<{
        status: string;
        disabledReason: string | null;
        failingSince: Date | null;
      }>(
        `SELECT status, "disabledReason", "failingSince" FROM "WebhookEndpoint" WHERE id = :id`,
        { id },
      )
    )[0];
  const disabledEvents = (endpointId: string) =>
    t.outboxEvents(DISABLED, { aggregateId: endpointId });
  const historyOf = (endpointId: string) =>
    t.rows<{
      facet: string;
      fromValue: string | null;
      toValue: string | null;
      actorId: string | null;
    }>(
      `SELECT facet, "fromValue", "toValue", "actorId" FROM "WebhookEndpointHistory" WHERE "endpointId" = :endpointId ORDER BY "createdAt", id`,
      { endpointId },
    );
  /** One routed event run once against a receiver that answers 500: the attempt fails inside the ordered lane. */
  const failOnce = async (endpointId: string, world: WebhookWorld = w) => {
    const message = await flow.route(world, endpointId);
    const result = await flow.lane.run(message);
    expect(result).toBe('redeliver');
    return message;
  };
  const at = (ms: number) => new Date(ms);

  describe('failure window and auto-disable (AS-55, AS-56, AS-59)', () => {
    it('S43 AS-55: a failure one second short of three days keeps the endpoint on; the failure at exactly three days switches it off in the same step with history, cancelled deliveries and one event', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 500 });
      const t0 = t.clock.now();

      const first = await failOnce(e.id);
      expect((await row(e.id)).failingSince?.toISOString()).toBe(
        t0.toISOString(),
      );

      t.clock.set(at(t0.getTime() + 3 * DAY - SEC));
      await failOnce(e.id);
      expect(await row(e.id)).toMatchObject({
        status: 'enabled',
        disabledReason: null,
      });
      expect((await row(e.id)).failingSince?.toISOString()).toBe(
        t0.toISOString(),
      );
      expect(await disabledEvents(e.id)).toHaveLength(0);

      const waiting = await flow.route(w, e.id); // queued, never attempted
      t.clock.set(at(t0.getTime() + 3 * DAY));
      const last = await failOnce(e.id);

      expect(await row(e.id)).toMatchObject({
        status: 'disabled',
        disabledReason: 'auto_failing',
      });
      expect(
        (await historyOf(e.id)).filter((h) => h.facet === 'status'),
      ).toEqual([
        {
          facet: 'status',
          fromValue: 'enabled',
          toValue: 'disabled',
          actorId: null,
        },
      ]);
      for (const m of [first, waiting, last])
        expect(await flow.delivery(m)).toMatchObject({
          state: 'cancelled',
          cancelReason: 'endpoint_disabled',
        });
      const events = await disabledEvents(e.id);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        endpointId: e.id,
        shopId: w.shop.id,
        host: receiver.host,
        failingSince: t0.toISOString(),
      });
      const changes = await t.outboxEvents(CHANGED, { aggregateId: e.id });
      expect(changes.map((c) => c.payload.change)).toEqual([
        'created',
        'disabled',
      ]);
      expect(
        MetricsRegistry.value('webhook_auto_disabled_total') ?? 0,
      ).toBeGreaterThanOrEqual(1);

      // a delivery message that is still in the queue sends nothing to the disabled endpoint
      const before = receiver.requests.length;
      expect(await flow.lane.run(waiting, 2)).toBe('skipped');
      expect(receiver.requests.length).toBe(before);
    });

    it('S43 AS-56: a 2xx resets the window: later failures start a new one and the endpoint is switched off only three days after that', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 500 });
      const t0 = t.clock.now();
      await failOnce(e.id);
      expect((await row(e.id)).failingSince?.toISOString()).toBe(
        t0.toISOString(),
      );

      t.clock.set(at(t0.getTime() + 2 * DAY));
      receiver.respondWith({ status: 200 });
      expect(await flow.lane.run(await flow.route(w, e.id))).toBe('delivered');
      expect((await row(e.id)).failingSince).toBeNull();

      const t1 = at(t0.getTime() + 2 * DAY + HOUR);
      t.clock.set(t1);
      receiver.respondWith({ status: 500 });
      await failOnce(e.id);
      expect((await row(e.id)).failingSince?.toISOString()).toBe(
        t1.toISOString(),
      );

      // three days after the FIRST failure the endpoint is still on
      t.clock.set(at(t0.getTime() + 3 * DAY + HOUR));
      await failOnce(e.id);
      expect((await row(e.id)).status).toBe('enabled');

      t.clock.set(at(t1.getTime() + 3 * DAY - SEC));
      await failOnce(e.id);
      expect((await row(e.id)).status).toBe('enabled');
      t.clock.set(at(t1.getTime() + 3 * DAY));
      await failOnce(e.id);
      expect(await row(e.id)).toMatchObject({
        status: 'disabled',
        disabledReason: 'auto_failing',
      });
      const events = await disabledEvents(e.id);
      expect(events).toHaveLength(1);
      expect(events[0].payload.failingSince).toBe(t1.toISOString());
    });

    it('S43 AS-59: enabling an auto-disabled endpoint clears the window, the breaker and the failure count; three more failing days disable it again with a second event for the new window', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 500 });
      const t0 = t.clock.now();
      await failOnce(e.id);
      await failOnce(e.id);
      t.clock.set(at(t0.getTime() + 3 * DAY));
      await failOnce(e.id);
      expect((await row(e.id)).status).toBe('disabled');
      expect((await breaker().get(e.id)).consecutiveFailures).toBe(3);
      expect(await disabledEvents(e.id)).toHaveLength(1);

      await t.reauth(w.owner); // the token expired while the clock moved three days
      const enabled = await t
        .as(w.owner)
        .post(`${t.base(w)}/${e.id}/enable`)
        .send({});
      expect(enabled.status).toBe(200);
      expect(enabled.body).toMatchObject({
        status: 'enabled',
        disabledReason: null,
        failingSince: null,
        breaker: 'closed',
      });
      expect(await row(e.id)).toMatchObject({
        status: 'enabled',
        failingSince: null,
      });
      expect(await breaker().get(e.id)).toMatchObject({
        consecutiveFailures: 0,
        openUntil: null,
      });

      const t1 = t.clock.now();
      await failOnce(e.id);
      expect((await row(e.id)).failingSince?.toISOString()).toBe(
        t1.toISOString(),
      );
      t.clock.set(at(t1.getTime() + 3 * DAY - SEC));
      await failOnce(e.id);
      expect((await row(e.id)).status).toBe('enabled');
      t.clock.set(at(t1.getTime() + 3 * DAY));
      await failOnce(e.id);
      expect((await row(e.id)).status).toBe('disabled');

      const events = await disabledEvents(e.id);
      expect(events.map((x) => x.payload.failingSince)).toEqual([
        t0.toISOString(),
        t1.toISOString(),
      ]);
    });
  });

  describe('sweep (AS-57)', () => {
    const makeFailing = async (id: string, since: Date) =>
      t.exec(
        `UPDATE "WebhookEndpoint" SET "failingSince" = :since WHERE id = :id`,
        {
          id,
          since,
        },
      );

    it('S43 AS-57: the sweep disables the endpoint past the window that has no running attempt and leaves the one inside it; a second run changes nothing', async () => {
      const dead = await setup();
      const alive = await setup();
      const now = t.clock.now();
      const pending = await flow.route(w, dead.e.id);
      await makeFailing(dead.e.id, at(now.getTime() - 3 * DAY - HOUR));
      await makeFailing(alive.e.id, at(now.getTime() - 2 * DAY));

      await sweep();
      await sweep();

      expect(await row(dead.e.id)).toMatchObject({
        status: 'disabled',
        disabledReason: 'auto_failing',
      });
      expect(await row(alive.e.id)).toMatchObject({
        status: 'enabled',
        disabledReason: null,
      });
      expect(await disabledEvents(dead.e.id)).toHaveLength(1);
      expect((await disabledEvents(dead.e.id))[0].payload).toEqual({
        endpointId: dead.e.id,
        shopId: w.shop.id,
        host: dead.receiver.host,
        failingSince: at(now.getTime() - 3 * DAY - HOUR).toISOString(),
      });
      expect(await disabledEvents(alive.e.id)).toHaveLength(0);
      expect(
        (await historyOf(dead.e.id)).filter((h) => h.facet === 'status'),
      ).toHaveLength(1);
      expect(await flow.delivery(pending)).toMatchObject({
        state: 'cancelled',
        cancelReason: 'endpoint_disabled',
      });
    });

    it('S43 AS-57: 20 rounds of 20 sweeps at the same moment produce exactly one disable and one event per window', async () => {
      for (let round = 0; round < 20; round++) {
        const { e } = await setup();
        await makeFailing(e.id, at(t.clock.now().getTime() - 3 * DAY - HOUR));

        await Promise.all(Array.from({ length: 20 }, () => sweep()));

        expect((await row(e.id)).status).toBe('disabled');
        expect(await disabledEvents(e.id)).toHaveLength(1);
        expect(
          (await historyOf(e.id)).filter((h) => h.facet === 'status'),
        ).toHaveLength(1);
        await t
          .as(w.owner)
          .delete(`${t.base(w)}/${e.id}`)
          .expect(204); // frees the slot of the 20-endpoint limit
      }
    }, 120_000);

    it('S43 AS-57: a failing attempt and a sweep racing for the same window disable once', async () => {
      for (let round = 0; round < 20; round++) {
        const { receiver, e } = await setup();
        receiver.respondWith({ status: 500 });
        const m = await flow.route(w, e.id);
        await makeFailing(e.id, at(t.clock.now().getTime() - 3 * DAY - HOUR));

        await Promise.all([flow.lane.run(m), sweep(), sweep()]);

        expect((await row(e.id)).status).toBe('disabled');
        expect(await disabledEvents(e.id)).toHaveLength(1);
        await t
          .as(w.owner)
          .delete(`${t.base(w)}/${e.id}`)
          .expect(204);
      }
    }, 120_000);
  });

  describe('retention (AS-67)', () => {
    const attemptsVia = (endpointId: string) =>
      t.as(w.owner).get(`${t.base(w)}/${endpointId}/attempts`);
    const historyCount = (endpointId: string) =>
      t
        .rows<{ n: string }>(
          `SELECT count(*) AS n FROM "WebhookEndpointHistory" WHERE "endpointId" = :endpointId`,
          { endpointId },
        )
        .then(([r]) => Number(r.n));

    it('S43 AS-67: a log item is returned one second before its 30 days are over and never from the instant they are, whether or not the store has removed it', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 200 });
      const message = await flow.route(w, e.id);
      expect(await flow.lane.run(message)).toBe('delivered');
      const created = t.clock.now();
      const detail = () =>
        t.as(w.owner).get(`${t.base(w)}/${e.id}/events/${message.eventId}`);

      t.clock.set(at(created.getTime() + 30 * DAY - SEC));
      await t.reauth(w.owner);
      expect((await attemptsVia(e.id)).body.items).toHaveLength(1);
      expect((await detail()).status).toBe(200);

      for (const offset of [0, SEC, DAY]) {
        t.clock.set(at(created.getTime() + 30 * DAY + offset));
        await t.reauth(w.owner);
        expect((await attemptsVia(e.id)).body.items).toEqual([]);
        const gone = await detail();
        expect(gone.status).toBe(404);
        expect(gone.body.code).toBe('webhook_event_not_found');
      }
      // the delivery worker does not resurrect it either
      expect(await flow.lane.run(message, 2)).toBe('skipped');
      expect(
        (await log().getDelivery(e.id, message.eventId, t.clock.now())) ?? null,
      ).toBeNull();
    });

    it('S43 AS-67: the state-change history is kept 400 days: a row survives until the instant it is that old, the purge job deletes it then and a repeat or a concurrent run changes nothing', async () => {
      const first = await setup();
      const t0 = t.clock.now();
      t.clock.set(at(t0.getTime() + DAY));
      await t.reauth(w.owner);
      const second = await setup();
      expect(await historyCount(first.e.id)).toBe(1);
      expect(await historyCount(second.e.id)).toBe(1);

      t.clock.set(at(t0.getTime() + 400 * DAY - SEC));
      await workers().purgeHistory();
      expect(await historyCount(first.e.id)).toBe(1);

      t.clock.set(at(t0.getTime() + 400 * DAY));
      await workers().purgeHistory();
      expect(await historyCount(first.e.id)).toBe(0);
      expect(await historyCount(second.e.id)).toBe(1);

      await workers().purgeHistory();
      await Promise.all(
        Array.from({ length: 10 }, () => workers().purgeHistory()),
      );
      expect(await historyCount(second.e.id)).toBe(1);

      t.clock.set(at(t0.getTime() + 401 * DAY));
      await workers().purgeHistory();
      expect(await historyCount(second.e.id)).toBe(0);
      // the endpoints themselves are not history
      expect((await row(first.e.id)).status).toBe('enabled');
    });

    it('S43 AS-67: the purge of the history is a scheduled single-run job and so is the sweep (registered when the worker booted)', () => {
      expect(schedulesAtBoot).toEqual([
        {
          name: 'webhooks.disable-failing-endpoints',
          jobType: 'webhooks.disable-failing-endpoints',
          overlap: 'skip',
          enabled: true,
        },
        {
          name: 'webhooks.purge-history',
          jobType: 'webhooks.purge-history',
          overlap: 'skip',
          enabled: true,
        },
      ]);
    });
  });

  describe('alert hygiene (AS-58)', () => {
    it('S43 AS-58: the event, every log line and every metric label carry the host and never the path, the query or the token', async () => {
      const { receiver, e } = await setup(w, '/in?token=SECRET123');
      receiver.respondWith({ status: 500 });
      const t0 = t.clock.now();
      const autoDisabled0 =
        MetricsRegistry.value('webhook_auto_disabled_total') ?? 0;
      await failOnce(e.id);
      t.clock.set(at(t0.getTime() + 3 * DAY));
      await failOnce(e.id);
      expect((await row(e.id)).status).toBe('disabled');

      const events = await disabledEvents(e.id);
      expect(events).toHaveLength(1);
      expect(events[0].payload.host).toBe(receiver.host);
      const outbox = JSON.stringify(
        await t.rows(`SELECT * FROM "Outbox" WHERE "aggregateId" = :id`, {
          id: e.id,
        }),
      );
      for (const forbidden of ['/in', 'token', 'SECRET123'])
        expect(outbox).not.toContain(forbidden);

      const logs = t.rawLogs();
      expect(logs).toContain(receiver.host);
      for (const forbidden of [
        'SECRET123',
        'token=',
        `${receiver.host}/`,
        `${receiver.host}:443/`,
      ])
        expect(logs).not.toContain(forbidden);

      const labels = JSON.stringify(
        [
          'webhook_auto_disabled_total',
          'webhook_delivery_attempts_total',
          'webhook_delivery_duration_seconds',
          'webhook_dead_lettered_total',
        ].map((name) => MetricsRegistry.labelSets(name)),
      );
      for (const forbidden of ['/in', 'token', 'SECRET123', receiver.host])
        expect(labels).not.toContain(forbidden);
      expect(MetricsRegistry.value('webhook_auto_disabled_total')).toBe(
        autoDisabled0 + 1,
      );
    });

    it('S43 AS-58: the disable, its history row and its event are one transaction: when the event cannot be written nothing changes, and the sweep completes it later without a duplicate', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 500 });
      const t0 = t.clock.now();
      await failOnce(e.id);
      t.clock.set(at(t0.getTime() + 3 * DAY));
      const outbox = t.app.get(OutboxService, { strict: false });
      const broken = jest
        .spyOn(outbox, 'append')
        .mockRejectedValue(new Error('outbox down'));
      try {
        await failOnce(e.id); // the attempt is recorded; the disable fails as a whole
        expect(await row(e.id)).toMatchObject({
          status: 'enabled',
          disabledReason: null,
        });
        expect(
          (await historyOf(e.id)).filter((h) => h.facet === 'status'),
        ).toHaveLength(0);
        expect(await disabledEvents(e.id)).toHaveLength(0);
      } finally {
        broken.mockRestore(); // L-013
      }

      await sweep();

      expect((await row(e.id)).status).toBe('disabled');
      expect(await disabledEvents(e.id)).toHaveLength(1);
      expect(
        (await historyOf(e.id)).filter((h) => h.facet === 'status'),
      ).toHaveLength(1);
    });
  });
});
