import {
  createdWebhookEndpointSchema,
  rotatedWebhookSecretSchema,
  WEBHOOK_ERROR_CODES,
  WEBHOOK_EVENT_TYPES,
  webhookAttemptPageSchema,
  webhookDeliveryAcceptedSchema,
  webhookEndpointPageSchema,
  webhookEndpointSchema,
  webhookErrorCodeSchema,
  webhookEventDetailSchema,
  webhookEventTypesResponseSchema,
  webhookProblemSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { WEBHOOK_QUEUE } from './domain/webhook-events';
import {
  DeliveryQueue,
  EndpointRepository,
  type DeliveryMessage,
} from './domain/webhook-ports';
import { WebhookOrdersConsumer } from './infra/webhook-consumers';
import { WebhookLambdaHandlerHost } from './infra/webhook-lambda.handler-host';
import {
  createWebhookKit,
  orderStatusEvent,
  waitFor,
  type WebhookKit,
  type WebhookWorld,
} from './testing/webhook-e2e.fixture';
import { createFlow, type Flow } from './testing/webhook-flow';
import { feed } from './testing/webhook-lane';
import { clearRateLimits } from './testing/public-api-kit';
import { WebhooksLambdaModule } from './webhooks-lambda.module';
import { WebhooksProjectorModule } from './webhooks-projector.module';
import { WebhooksWorkerModule } from './webhooks-worker.module';

const SEC = 1000;
const OUTCOMES = [
  'delivered',
  'failed',
  'timeout',
  'blocked',
  'breaker_skipped',
  'cancelled',
];

describe('Webhooks: observability, problem details and contracts', () => {
  let queue: InMemoryTaskQueue;
  let t: WebhookKit;
  let flow: Flow;
  let w: WebhookWorld;

  beforeAll(async () => {
    queue = new InMemoryTaskQueue();
    t = await createWebhookKit({
      structuredLogger: true,
      extraImports: [
        WebhooksProjectorModule,
        WebhooksWorkerModule,
        WebhooksLambdaModule,
      ],
      overrides: [{ provide: TaskQueue, useValue: queue }],
    });
    flow = createFlow(t, queue);
  }, 120_000);
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await clearRateLimits(t.app);
    queue.sent.length = 0;
    w = await t.seedWorld();
  });

  const base = () => t.base(w);
  const setup = async (path = '/in') => {
    const receiver = await t.startReceiver();
    const e = await flow.endpoint(w, receiver.url(path));
    return { receiver, e };
  };
  const counter = (name: string, labels: Record<string, string> = {}) =>
    MetricsRegistry.value(name, labels) ?? 0;
  const observations = (name: string) =>
    MetricsRegistry.histogramValue(name, {})?.count ?? 0;
  const logLines = (): Record<string, unknown>[] =>
    t
      .rawLogs()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });

  describe('observability (AS-68)', () => {
    it('S43 AS-68: a delivered and a failed attempt increase the attempt counter by outcome and the duration histogram, and each leaves one structured line with the correlation, delivery, endpoint, event, attempt, status and host and nothing of the address path, query, secret, signature or body', async () => {
      const { receiver, e } = await setup('/in?token=PATHSECRET');
      const delivered0 = counter('webhook_delivery_attempts_total', {
        outcome: 'delivered',
      });
      const failed0 = counter('webhook_delivery_attempts_total', {
        outcome: 'failed',
      });
      const durations0 = observations('webhook_delivery_duration_seconds');

      receiver.respondWith({ status: 200 }, { status: 500 });
      const ok = await flow.route(w, e.id, {
        lines: [{ title: 'Highly Confidential Mug' }],
      });
      expect(await flow.lane.run(ok)).toBe('delivered');
      const bad = await flow.route(w, e.id, {
        lines: [{ title: 'Highly Confidential Mug' }],
      });
      expect(await flow.lane.run(bad)).toBe('redeliver');

      expect(
        counter('webhook_delivery_attempts_total', { outcome: 'delivered' }),
      ).toBe(delivered0 + 1);
      expect(
        counter('webhook_delivery_attempts_total', { outcome: 'failed' }),
      ).toBe(failed0 + 1);
      expect(observations('webhook_delivery_duration_seconds')).toBe(
        durations0 + 2,
      );

      const lines = logLines().filter(
        (l) => l.action === 'webhook.attempt' && l.endpointId === e.id,
      );
      expect(lines).toHaveLength(2);
      for (const [line, message, status] of [
        [lines[0], ok, 200],
        [lines[1], bad, 500],
      ] as const) {
        expect(line.requestId ?? line.traceId).toBeTruthy();
        expect(line).toMatchObject({
          deliveryId: message.deliveryId,
          endpointId: e.id,
          eventId: message.eventId,
          attempt: 1,
          status,
          host: receiver.host,
        });
      }
      const everything = t.rawLogs();
      const stored = (await flow.delivery(ok)).body;
      for (const forbidden of [
        '/in?token',
        'PATHSECRET',
        e.secret,
        'v1=',
        'Highly Confidential Mug',
        stored.slice(0, 40),
      ])
        expect(everything).not.toContain(forbidden);
    });

    it('S43 AS-68: the lane age, the breaker-open count, the routing lag and the dead-letter counters are written, not only registered', async () => {
      const { receiver, e } = await setup();
      const lag0 = observations('webhook_routing_lag_seconds');

      // lane age: a delivery waited 7 s in the queue before a worker took it
      const waiting = await flow.route(w, e.id);
      expect(observations('webhook_routing_lag_seconds')).toBe(lag0 + 1);
      t.clock.advance(7 * SEC);
      expect(await flow.lane.run(waiting)).toBe('delivered');
      expect(MetricsRegistry.value('webhook_lane_age_seconds')).toBe(7);

      // breaker: five failures open it, a successful probe closes it
      const open0 = counter('webhook_endpoints_breaker_open');
      receiver.respondWith({ status: 500 });
      for (let i = 0; i < 5; i++) {
        t.clock.advance(SEC);
        await flow.lane.run(await flow.route(w, e.id));
      }
      expect(counter('webhook_endpoints_breaker_open')).toBe(open0 + 1);
      receiver.respondWith({ status: 200 });
      t.clock.advance(5 * 60_000);
      expect(await flow.lane.run(await flow.route(w, e.id))).toBe('delivered');
      expect(counter('webhook_endpoints_breaker_open')).toBe(open0);
    });

    it('S43 AS-68: a body the delivery lane cannot use is counted as dead-lettered on lane delivery (worker and Lambda host), an event the router cannot apply on lane router', async () => {
      const delivery0 = counter('webhook_dead_lettered_total', {
        lane: 'delivery',
      });
      const router0 = counter('webhook_dead_lettered_total', {
        lane: 'router',
      });

      queue.sent.push({ queue: WEBHOOK_QUEUE, body: { not: 'a delivery' } });
      await queue.drain(WEBHOOK_QUEUE);
      expect(queue.deadLettered).toHaveLength(1);
      expect(counter('webhook_dead_lettered_total', { lane: 'delivery' })).toBe(
        delivery0 + 1,
      );

      const host = t.app.get(WebhookLambdaHandlerHost);
      await expect(
        host.handleRecord('{"not":"a delivery"}', 4),
      ).rejects.toThrow();
      expect(counter('webhook_dead_lettered_total', { lane: 'delivery' })).toBe(
        delivery0 + 1,
      ); // the queue redelivers it; it is not dead yet
      await expect(
        host.handleRecord('{"not":"a delivery"}', 5),
      ).rejects.toThrow();
      expect(counter('webhook_dead_lettered_total', { lane: 'delivery' })).toBe(
        delivery0 + 2,
      ); // fifth receive: the redrive policy moves it

      // a cancelled order that names no shop cannot be routed; the same event again is the same dead letter
      const poison = orderStatusEvent('order.cancelled', {});
      const consumer = t.app.get(WebhookOrdersConsumer);
      expect(await feed(consumer, [poison])).toHaveLength(1);
      expect(await feed(consumer, [poison])).toHaveLength(1);
      expect(counter('webhook_dead_lettered_total', { lane: 'router' })).toBe(
        router0 + 1,
      );
    });

    it('S43 AS-68: label values stay in their closed lists', () => {
      for (const labels of MetricsRegistry.labelSets(
        'webhook_delivery_attempts_total',
      ))
        expect(OUTCOMES).toContain(labels.outcome);
      for (const labels of MetricsRegistry.labelSets(
        'webhook_dead_lettered_total',
      ))
        expect(['router', 'delivery']).toContain(labels.lane);
      for (const name of [
        'webhook_delivery_duration_seconds',
        'webhook_routing_lag_seconds',
        'webhook_lane_age_seconds',
        'webhook_endpoints_breaker_open',
        'webhook_breaker_degraded_total',
        'webhook_auto_disabled_total',
      ])
        expect(
          MetricsRegistry.labelSets(name).every(
            (l) => Object.keys(l).length === 0,
          ),
        ).toBe(true);
    });
  });

  describe('contracts and errors (AS-69)', () => {
    const seen = new Set<string>();
    const problem = (
      res: { status: number; headers: Record<string, unknown>; body: any },
      status: number,
      code: string,
    ) => {
      expect(res.status).toBe(status);
      expect(String(res.headers['content-type'])).toMatch(
        /^application\/problem\+json/,
      );
      const parsed = webhookProblemSchema.parse(res.body);
      expect(parsed.status).toBe(status);
      expect(parsed.code).toBe(code);
      seen.add(code);
      return parsed;
    };

    it('S43 AS-69: every success body of every route parses with its contract schema', async () => {
      const receiver = await t.startReceiver();
      const owner = t.as(w.owner);

      const types = await owner.get(
        `/api/shops/${w.shop.id}/developers/webhook-event-types`,
      );
      expect(types.status).toBe(200);
      expect(
        webhookEventTypesResponseSchema
          .parse(types.body)
          .items.map((i) => i.type),
      ).toEqual([...WEBHOOK_EVENT_TYPES]);

      const created = await owner
        .post(base())
        .send({ url: receiver.url(), events: ['order.paid'] });
      expect(created.status).toBe(201);
      const e = createdWebhookEndpointSchema.parse(created.body);
      const one = `${base()}/${e.id}`;

      const list = await owner.get(base());
      expect(list.status).toBe(200);
      expect(webhookEndpointPageSchema.parse(list.body).items).toHaveLength(1);
      expect(webhookEndpointSchema.parse((await owner.get(one)).body).id).toBe(
        e.id,
      );
      const patched = await owner
        .patch(one)
        .send({ events: ['order.paid', 'payout.paid'] });
      expect(patched.status).toBe(200);
      webhookEndpointSchema.parse(patched.body);
      for (const action of ['disable', 'enable']) {
        const res = await owner.post(`${one}/${action}`).send({});
        expect(res.status).toBe(200);
        webhookEndpointSchema.parse(res.body);
      }
      const rotated = await owner.post(`${one}/rotate-secret`).send({});
      expect(rotated.status).toBe(201);
      rotatedWebhookSecretSchema.parse(rotated.body);
      const expired = await owner
        .post(`${one}/expire-previous-secret`)
        .send({});
      expect(expired.status).toBe(200);
      webhookEndpointSchema.parse(expired.body);

      const message = await flow.route(w, e.id);
      expect(await flow.lane.run(message)).toBe('delivered');
      const attempts = await owner.get(`${one}/attempts`);
      expect(attempts.status).toBe(200);
      expect(webhookAttemptPageSchema.parse(attempts.body).items).toHaveLength(
        1,
      );
      const detail = await owner.get(`${one}/events/${message.eventId}`);
      expect(detail.status).toBe(200);
      webhookEventDetailSchema.parse(detail.body);
      const replayed = await owner
        .post(`${one}/events/${message.eventId}/replay`)
        .set('Idempotency-Key', 'contract-replay-key')
        .send({});
      expect(replayed.status).toBe(202);
      webhookDeliveryAcceptedSchema.parse(replayed.body);
      const pinged = await owner.post(`${one}/ping`).send({});
      expect(pinged.status).toBe(202);
      webhookDeliveryAcceptedSchema.parse(pinged.body);
      const removed = await owner.delete(one);
      expect(removed.status).toBe(204);
      expect(removed.text).toBe('');
    });

    it('S43 AS-69: every failure is problem+json with the documented status and code, and the routes between them use every code of the catalogue', async () => {
      seen.clear();
      const receiver = await t.startReceiver();
      const owner = t.as(w.owner);
      const created = await owner
        .post(base())
        .send({ url: receiver.url(), events: ['order.paid'] });
      const e = createdWebhookEndpointSchema.parse(created.body);
      const one = `${base()}/${e.id}`;
      const unknown = `${base()}/${'0190aaaa-0000-7000-8000-000000000000'}`;
      const delivered = await flow.route(w, e.id);
      await flow.lane.run(delivered);
      const eventPath = `${one}/events/${delivered.eventId}`;

      // authentication and authorisation
      const anonymous = await t.http().get(base());
      expect(anonymous.status).toBe(401);
      expect(String(anonymous.headers['content-type'])).toMatch(
        /^application\/problem\+json/,
      );
      webhookProblemSchema.parse(anonymous.body);
      problem(await t.as(w.staff).get(base()), 403, 'permission_denied');

      // validation and cursors
      const bad = problem(
        await owner.post(base()).send({ url: '', events: [] }),
        400,
        'validation_failed',
      );
      expect(bad.errors?.length).toBeGreaterThan(0);
      problem(
        await owner.get(`${base()}?cursor=garbage`),
        400,
        'invalid_cursor',
      );
      problem(
        await owner.get(`${one}/attempts?cursor=garbage`),
        400,
        'invalid_cursor',
      );

      // not found
      problem(await owner.get(unknown), 404, 'webhook_endpoint_not_found');
      problem(
        await owner.get(`${one}/events/evt_${'0'.repeat(32)}`),
        404,
        'webhook_event_not_found',
      );

      // conflicts and rejections
      problem(
        await owner
          .post(base())
          .send({ url: receiver.url(), events: ['order.paid'] }),
        409,
        'duplicate_endpoint_url',
      );
      const rejected = problem(
        await owner
          .post(base())
          .send({ url: 'http://hooks.acme.test/in', events: ['order.paid'] }),
        422,
        'endpoint_url_rejected',
      );
      expect(rejected.details).toEqual({ reason: 'not_https' });
      const conflict = problem(
        await owner.post(`${one}/enable`).send({}),
        409,
        'endpoint_state_conflict',
      );
      expect(conflict.details).toEqual({ status: 'enabled' });
      problem(
        await owner.post(`${one}/expire-previous-secret`).send({}),
        409,
        'no_previous_secret',
      );
      expect((await owner.post(`${one}/rotate-secret`).send({})).status).toBe(
        201,
      );
      problem(
        await owner.post(`${one}/rotate-secret`).send({}),
        409,
        'rotation_in_progress',
      );

      // replay and ping
      problem(
        await owner.post(`${eventPath}/replay`).send({}),
        422,
        'idempotency_key_required',
      );
      const key = 'contract-key-0001';
      expect(
        (
          await owner
            .post(`${eventPath}/replay`)
            .set('Idempotency-Key', key)
            .send({})
        ).status,
      ).toBe(202);
      problem(
        await owner
          .post(`${one}/events/evt_${'1'.repeat(32)}/replay`)
          .set('Idempotency-Key', key)
          .send({}),
        422,
        'idempotency_key_reuse',
      );
      const queueOf = t.app.get(DeliveryQueue, { strict: false });
      const real = queueOf.enqueue.bind(queueOf);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered = 0;
      const hold = jest
        .spyOn(queueOf, 'enqueue')
        .mockImplementation(async (m: DeliveryMessage) => {
          entered++;
          await gate;
          return real(m);
        });
      try {
        const first = owner
          .post(`${eventPath}/replay`)
          .set('Idempotency-Key', 'contract-key-0002')
          .send({})
          .then((r) => r); // superagent sends on the first then()
        await waitFor(() => entered === 1, 'the first replay to be in flight');
        problem(
          await owner
            .post(`${eventPath}/replay`)
            .set('Idempotency-Key', 'contract-key-0002')
            .send({}),
          409,
          'idempotency_in_flight',
        );
        release();
        expect((await first).status).toBe(202);
      } finally {
        hold.mockRestore();
      }
      const down = jest
        .spyOn(queueOf, 'enqueue')
        .mockRejectedValue(new Error('queue down'));
      try {
        problem(
          await owner.post(`${one}/ping`).send({}),
          503,
          'service_unavailable',
        );
      } finally {
        down.mockRestore();
      }
      expect((await owner.post(`${one}/disable`).send({})).status).toBe(200);
      problem(
        await owner.post(`${one}/ping`).send({}),
        409,
        'endpoint_disabled',
      );
      expect((await owner.post(`${one}/enable`).send({})).status).toBe(200);
      for (let i = 0; i < 10; i++) await owner.post(`${one}/ping`).send({});
      const limited = problem(
        await owner.post(`${one}/ping`).send({}),
        429,
        'rate_limited',
      );
      expect(limited).toBeDefined();

      // the endpoint limit
      for (let i = 0; i < 19; i++)
        expect(
          (
            await owner
              .post(base())
              .send({ url: t.endpointUrl(), events: ['order.paid'] })
          ).status,
        ).toBe(201);
      problem(
        await owner
          .post(base())
          .send({ url: t.endpointUrl(), events: ['order.paid'] }),
        422,
        'endpoint_limit_reached',
      );

      // delete: the second one is a 404
      expect((await owner.delete(one)).status).toBe(204);
      problem(await owner.delete(one), 404, 'webhook_endpoint_not_found');

      // every documented code was produced, and every produced code is documented
      for (const code of seen)
        expect(webhookErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(WEBHOOK_ERROR_CODES.filter((code) => !seen.has(code))).toEqual([]);
    }, 120_000);

    it('S43 AS-69: an unexpected failure is a 500 problem with a generic detail: no stack, no SQL, no text of the failing component', async () => {
      const { e } = await setup();
      const repo = t.app.get(EndpointRepository, { strict: false });
      const broken = jest.spyOn(repo, 'findById').mockRejectedValue(
        Object.assign(
          new Error(
            'select * from "WebhookEndpoint" where id = $1: connection to 10.1.2.3:5432 refused',
          ),
          {
            stack:
              'Error: boom\n    at Sequelize.query (/srv/node_modules/pg/lib/client.js:526:17)',
          },
        ),
      );
      try {
        const res = await t.as(w.owner).get(`${base()}/${e.id}`);
        expect(res.status).toBe(500);
        expect(String(res.headers['content-type'])).toMatch(
          /^application\/problem\+json/,
        );
        const parsed = webhookProblemSchema.parse(res.body);
        expect(parsed.code).toBe('internal_error');
        const text = JSON.stringify(res.body);
        for (const leak of [
          'select',
          'WebhookEndpoint',
          '10.1.2.3',
          'node_modules',
          'client.js',
          'Sequelize',
          'stack',
          'refused',
        ])
          expect(text).not.toContain(leak);
      } finally {
        broken.mockRestore(); // L-013
      }
    });
  });
});
