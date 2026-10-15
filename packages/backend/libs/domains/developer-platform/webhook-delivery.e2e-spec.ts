import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { verifyWebhook } from './domain/signature';
import { WEBHOOK_QUEUE } from './domain/webhook-events';
import {
  BreakerStore,
  DeliveryLog,
  type DeliveryMessage,
} from './domain/webhook-ports';
import { WebhookLambdaHandlerHost } from './infra/webhook-lambda.handler-host';
import { WebhookWorkers } from './infra/webhook-workers';
import {
  createWebhookKit,
  waitFor,
  type WebhookKit,
  type WebhookWorld,
} from './testing/webhook-e2e.fixture';
import { createFlow, type Flow } from './testing/webhook-flow';
import { clearRateLimits } from './testing/public-api-kit';
import { WebhooksLambdaModule } from './webhooks-lambda.module';
import { WebhooksProjectorModule } from './webhooks-projector.module';
import { WebhooksWorkerModule } from './webhooks-worker.module';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('Webhooks: delivery, ordering, retries and circuit breaker', () => {
  let queue: InMemoryTaskQueue;
  let t: WebhookKit;
  let flow: Flow;
  let w: WebhookWorld;

  beforeAll(async () => {
    queue = new InMemoryTaskQueue();
    t = await createWebhookKit({
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

  const log = () => t.app.get(DeliveryLog, { strict: false });
  const breaker = () => t.app.get(BreakerStore, { strict: false });
  const workers = () => t.app.get(WebhookWorkers);
  /** An endpoint on its own receiver; the shop is the test's world unless another is given. */
  const setup = async (world: WebhookWorld = w) => {
    const receiver = await t.startReceiver();
    const e = await flow.endpoint(world, receiver.url());
    return { receiver, e };
  };
  const state = async (m: { endpointId: string; eventId: string }) =>
    (await flow.delivery(m)).state;

  describe('delivery (AS-35, AS-36, AS-37, AS-42)', () => {
    it('S43 AS-35: the registered consumer posts the stored body with the contract headers and a verifiable signature, records one attempt and marks the delivery delivered', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 200, body: 'accepted' });
      const message = await flow.route(w, e.id);
      queue.sent.push({ queue: WEBHOOK_QUEUE, body: message });

      await queue.drain(WEBHOOK_QUEUE);

      expect(receiver.requests).toHaveLength(1);
      const [request] = receiver.requests;
      const stored = await flow.delivery(message);
      expect(request.method).toBe('POST');
      expect(request.headers['content-type']).toBe('application/json');
      expect(request.headers['user-agent']).toBe('Marketplace-Webhooks/1');
      expect(request.eventId).toBe(message.eventId);
      expect(request.deliveryId).toBe(message.deliveryId);
      expect(request.eventType).toBe('order.paid');
      expect(request.attempt).toBe(1);
      expect(request.replay).toBe(false);
      expect(request.body).toBe(stored.body);
      expect(
        verifyWebhook(request.body, request.signature, e.secret, {
          now: t.clock.now().getTime(),
        }),
      ).toBe(true);
      expect(stored.state).toBe('delivered');
      const attempts = await flow.attempts(e.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attempt: 1,
        status: 200,
        ok: true,
        responseSnippet: 'accepted',
        replay: false,
      });
      expect(attempts[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(await flow.failingSince(e.id)).toBeNull();
    });

    it('S43 AS-36: five events of one endpoint arrive in routed order, one request in flight at a time', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 200, delayMs: 30 });
      const sent: DeliveryMessage[] = [];
      for (let i = 0; i < 5; i++) sent.push(await flow.route(w, e.id));

      for (const m of sent) expect(await flow.lane.run(m)).toBe('delivered');

      expect(receiver.requests.map((r) => r.eventId)).toEqual(
        sent.map((m) => m.eventId),
      );
      expect(receiver.maxInFlight).toBe(1);
    });

    it('S43 AS-37: an endpoint whose receiver never answers does not delay another shop: its 20 deliveries all finish within 2 s of queueing and the hanging attempt ends within 10 s', async () => {
      const w3 = await t.seedWorld();
      const hang = await setup();
      hang.receiver.respondWith({ hang: true });
      const healthy = await setup(w3);
      const stuck: DeliveryMessage[] = [];
      const fine: DeliveryMessage[] = [];
      for (let i = 0; i < 20; i++) {
        stuck.push(await flow.route(w, hang.e.id));
        fine.push(await flow.route(w3, healthy.e.id));
      }

      const started = Date.now();
      const hanging = flow.lane.run(stuck[0]);
      const finishedAt: number[] = [];
      for (const m of fine) {
        expect(await flow.lane.run(m)).toBe('delivered');
        finishedAt.push(Date.now() - started);
      }
      expect(Math.max(...finishedAt)).toBeLessThan(2000);
      expect(healthy.receiver.requests).toHaveLength(20);

      expect(await hanging).toBe('redeliver');
      const ended = Date.now() - started;
      expect(ended).toBeGreaterThanOrEqual(9_500);
      expect(ended).toBeLessThan(12_000);
      const [attempt] = await flow.attempts(hang.e.id);
      expect(attempt).toMatchObject({
        ok: false,
        status: null,
        error: 'timeout',
      });
    }, 60_000);

    it('S43 AS-42: an event that left the lane is delivered later with the same id and the same bytes, after the newer event; the failure window is cleared', async () => {
      const { receiver, e } = await setup();
      const e1 = await flow.route(w, e.id);
      const e2 = await flow.route(w, e.id);
      receiver.respondWith({ status: 500 }, { status: 500 }, { status: 500 });
      expect(await flow.lane.run(e1, 1)).toBe('redeliver');
      t.clock.advance(30_000);
      expect(await flow.lane.run(e1, 2)).toBe('redeliver');
      t.clock.advance(30_000);
      expect(await flow.lane.run(e1, 3)).toBe('retry_scheduled');
      expect(await flow.failingSince(e.id)).not.toBeNull();

      receiver.respondWith({ status: 200 });
      expect(await flow.lane.run(e2)).toBe('delivered');
      const [job] = await flow.lane.retryJobs(e.id, e1.eventId);
      t.clock.set(job.runAt);
      const back = await flow.lane.runRetryJob(job);
      expect(await flow.lane.run(back)).toBe('delivered');

      const seen = receiver.requests.map((r) => r.eventId);
      expect(seen).toEqual([
        e1.eventId,
        e1.eventId,
        e1.eventId,
        e2.eventId,
        e1.eventId,
      ]);
      const bodies = receiver.requests
        .filter((r) => r.eventId === e1.eventId)
        .map((r) => r.body);
      expect(new Set(bodies).size).toBe(1);
      expect(receiver.requests.at(-1)!.attempt).toBe(4);
      expect(await state(e1)).toBe('delivered');
      expect(await flow.failingSince(e.id)).toBeNull();
    });
  });

  describe('timeouts and classification (AS-38, AS-39, AS-53)', () => {
    it('S43 AS-38: a receiver that never answers and one that drips a byte a second are both cut at 10 s overall and logged as timeouts; a 1 MiB answer is read to 1 KiB and counts as its status', async () => {
      const hang = await setup();
      hang.receiver.respondWith({ hang: true });
      const drip = await setup();
      drip.receiver.respondWith({ slowDrip: true, intervalMs: 1000 });
      const big = await setup();
      big.receiver.respondWith({ bigBody: 1024 * 1024 });
      const [mh, md, mb] = [
        await flow.route(w, hang.e.id),
        await flow.route(w, drip.e.id),
        await flow.route(w, big.e.id),
      ];

      const started = Date.now();
      const [rh, rd, rb] = await Promise.all([
        flow.lane.run(mh),
        flow.lane.run(md),
        flow.lane.run(mb),
      ]);
      const elapsed = Date.now() - started;

      expect(rh).toBe('redeliver');
      expect(rd).toBe('redeliver');
      expect(rb).toBe('delivered');
      expect(elapsed).toBeGreaterThanOrEqual(9_500);
      expect(elapsed).toBeLessThan(13_000);
      for (const e of [hang.e, drip.e]) {
        const [a] = await flow.attempts(e.id);
        expect(a).toMatchObject({ ok: false, status: null, error: 'timeout' });
      }
      const [ab] = await flow.attempts(big.e.id);
      expect(ab).toMatchObject({ ok: true, status: 200 });
      expect(Buffer.byteLength(ab.responseSnippet ?? '')).toBeLessThanOrEqual(
        1024,
      );
    }, 60_000);

    it('S43 AS-39: any 2xx delivers; a 301 is not followed and fails; 4xx, 5xx and a reset fail and are retried; Retry-After stretches the retry up to 24 h', async () => {
      for (const status of [200, 201, 202, 204]) {
        const { receiver, e } = await setup();
        receiver.respondWith({ status });
        const m = await flow.route(w, e.id);
        expect(await flow.lane.run(m)).toBe('delivered');
        expect((await flow.attempts(e.id))[0]).toMatchObject({
          status,
          ok: true,
        });
      }

      const trap = await t.startReceiver();
      const redirecting = await setup();
      redirecting.receiver.respondWith({
        redirect: trap.url('/elsewhere'),
        status: 301,
      });
      const mr = await flow.route(w, redirecting.e.id);
      expect(await flow.lane.run(mr)).toBe('redeliver');
      expect(trap.requests).toHaveLength(0);
      expect(trap.connections).toBe(0);
      expect((await flow.attempts(redirecting.e.id))[0]).toMatchObject({
        status: 301,
        ok: false,
      });

      for (const status of [400, 401, 404, 410, 422, 500, 502]) {
        const { receiver, e } = await setup();
        receiver.respondWith({ status });
        const m = await flow.route(w, e.id);
        expect(await flow.lane.run(m)).toBe('redeliver');
        expect((await flow.attempts(e.id))[0]).toMatchObject({
          status,
          ok: false,
        });
        expect(await state(m)).toBe('retry_scheduled');
      }
      const reset = await setup();
      reset.receiver.respondWith({ reset: true });
      const mReset = await flow.route(w, reset.e.id);
      expect(await flow.lane.run(mReset)).toBe('redeliver');
      expect((await flow.attempts(reset.e.id))[0]).toMatchObject({
        status: null,
        ok: false,
        error: 'network_error',
      });

      for (const [status, seconds, expected] of [
        [408, 7200, 7200],
        [429, 7200, 7200],
        [503, 7200, 7200],
        [503, 999_999, 24 * 3600],
      ] as const) {
        const { receiver, e } = await setup();
        receiver.respondWith({
          status,
          headers: { 'Retry-After': String(seconds) },
        });
        const m = await flow.route(w, e.id);
        expect(await flow.lane.run(m)).toBe('retry_scheduled');
        const [job] = await flow.lane.retryJobs(e.id, m.eventId);
        expect(job.runAt.getTime() - t.clock.now().getTime()).toBe(
          expected * 1000,
        );
        expect((await flow.delivery(m)).nextAttemptAt).toEqual(job.runAt);
      }
    }, 60_000);

    it('S43 AS-53: a body over 256 KiB is not sent; the delivery is failed (payload_too_large) on attempt 1 and not retried', async () => {
      const { receiver, e } = await setup();
      const m = await flow.route(w, e.id, {
        lines: [{ title: 'x'.repeat(300 * 1024) }],
      });

      expect(await flow.lane.run(m)).toBe('failed');

      expect(receiver.connections).toBe(0);
      const stored = await flow.delivery(m);
      expect(stored).toMatchObject({
        state: 'failed',
        failureReason: 'payload_too_large',
      });
      expect(Buffer.byteLength(stored.body)).toBeGreaterThan(256 * 1024);
      const attempts = await flow.attempts(e.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attempt: 1,
        ok: false,
        status: null,
        error: 'payload_too_large',
      });
      expect(await flow.lane.retryJobs(e.id)).toEqual([]);
      expect(await flow.lane.run(m, 2)).toBe('skipped');
    });
  });

  describe('retries (AS-40, AS-43)', () => {
    it('S43 AS-40: three attempts in the ordered lane 30 s apart, then the retry lane on the schedule, exhausted after the 11th attempt, replayable data kept', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 500 });
      const m = await flow.route(w, e.id);
      const start = t.clock.now().getTime();

      expect(await flow.lane.run(m, 1)).toBe('redeliver');
      let record = await flow.delivery(m);
      expect(record).toMatchObject({ state: 'retry_scheduled', attempt: 2 });
      expect(record.nextAttemptAt!.getTime() - start).toBe(30_000);
      t.clock.advance(30_000);
      expect(await flow.lane.run(m, 2)).toBe('redeliver');
      record = await flow.delivery(m);
      expect(record).toMatchObject({ state: 'retry_scheduled', attempt: 3 });
      expect(record.nextAttemptAt!.getTime() - t.clock.now().getTime()).toBe(
        30_000,
      );
      t.clock.advance(30_000);
      expect(await flow.lane.run(m, 3)).toBe('retry_scheduled');

      // attempts 4 to 11 leave the lane: each retry waits its delay (jitter source fixed at 0.5 = no jitter)
      const delays = [5, 30, 120, 300, 600, 1440, 1440, 1440].map(
        (x) => x * MIN,
      );
      for (const [i, delay] of delays.entries()) {
        const jobs = await flow.lane.retryJobs(e.id, m.eventId);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].runAt.getTime() - t.clock.now().getTime()).toBe(delay);
        t.clock.set(jobs[0].runAt);
        const back = await flow.lane.runRetryJob(jobs[0]);
        expect(back.attempt).toBe(4 + i);
        const result = await flow.lane.run(back, 1);
        expect(result).toBe(
          i === delays.length - 1 ? 'exhausted' : 'retry_scheduled',
        );
      }

      expect(await flow.lane.retryJobs(e.id, m.eventId)).toEqual([]);
      expect(await flow.delivery(m)).toMatchObject({
        state: 'exhausted',
        attempt: 11,
      });
      const attempts = await flow.attempts(e.id, m.eventId);
      expect(attempts.map((a) => a.attempt)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      expect(receiver.requests.map((r) => r.attempt)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      expect(await flow.lane.run(m, 9)).toBe('skipped'); // no twelfth attempt
      expect(receiver.requests).toHaveLength(11);
    }, 60_000);

    it('S43 AS-43: a worker that dies after sending leaves the attempt in doubt; the repeat after the visibility timeout is attempt 2 with the same event id and body, and nothing is lost', async () => {
      const { receiver, e } = await setup();
      const m = await flow.route(w, e.id);
      const record = jest
        .spyOn(log(), 'recordAttempt')
        .mockRejectedValueOnce(new Error('worker killed before recording'));
      try {
        await expect(workers().handle(m, 1)).rejects.toThrow('worker killed');
      } finally {
        record.mockRestore(); // L-013
      }
      expect(receiver.requests).toHaveLength(1);
      expect(await flow.attempts(e.id)).toEqual([]);

      t.clock.advance(30_000); // the visibility timeout (30 s) passed: the queue shows the message again
      expect(await flow.lane.run(m, 2)).toBe('delivered');

      expect(receiver.requests).toHaveLength(2);
      expect(receiver.requests.map((r) => r.attempt)).toEqual([1, 2]);
      expect(receiver.requests[1].eventId).toBe(receiver.requests[0].eventId);
      expect(receiver.requests[1].body).toBe(receiver.requests[0].body);
      const attempts = await flow.attempts(e.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ attempt: 2, ok: true });
      expect(await state(m)).toBe('delivered');
    });
  });

  describe('duplicates, batches and poison (AS-44, AS-45, AS-46)', () => {
    it('S43 AS-44: a delivered message handled again sends nothing; two workers on the same pending delivery send once (20 rounds)', async () => {
      const { receiver, e } = await setup();
      const first = await flow.route(w, e.id);
      expect(await flow.lane.run(first)).toBe('delivered');
      expect(await flow.lane.run(first, 2)).toBe('skipped');
      expect(receiver.requests).toHaveLength(1);

      for (let round = 0; round < 20; round++) {
        const m = await flow.route(w, e.id);
        const before = receiver.requests.length;
        const [a, b] = await Promise.all([
          flow.lane.run(m),
          workers().handle(m, 1),
        ]);
        expect([a, b].filter((r) => r === 'delivered')).toHaveLength(1);
        expect([a, b].filter((r) => r === 'skipped')).toHaveLength(1);
        expect(receiver.requests.length).toBe(before + 1);
        expect(await flow.attempts(e.id, m.eventId)).toHaveLength(1);
      }
    });

    it('S43 AS-45: in a batch of three messages the endpoint that answers 500 is the only one reported failed; the other two are sent once', async () => {
      const host = t.app.get(WebhookLambdaHandlerHost, { strict: false });
      const targets = [await setup(), await setup(), await setup()];
      targets[1].receiver.respondWith({ status: 500 });
      const messages: DeliveryMessage[] = [];
      for (const x of targets) messages.push(await flow.route(w, x.e.id));

      const failed: number[] = [];
      for (const [i, m] of messages.entries()) {
        try {
          await host.handleRecord(JSON.stringify(m), 1);
        } catch {
          failed.push(i);
        }
      }

      expect(failed).toEqual([1]);
      for (const x of targets) expect(x.receiver.requests).toHaveLength(1);
      expect(await state(messages[0])).toBe('delivered');
      expect(await state(messages[1])).toBe('retry_scheduled');
      expect(await state(messages[2])).toBe('delivered');
    });

    it('S43 AS-46: an invalid message fails without any request and does not block the group; a valid message that failed while the log store was down is delivered exactly once after the redrive', async () => {
      const host = t.app.get(WebhookLambdaHandlerHost, { strict: false });
      const { receiver, e } = await setup();
      const m = await flow.route(w, e.id);

      for (const poison of ['not json', '{"endpointId":1}', '{}'])
        await expect(host.handleRecord(poison, 1)).rejects.toThrow();
      expect(receiver.connections).toBe(0);

      // the log store is down: the message is received five times and ends in the dead-letter lane
      const down = jest
        .spyOn(log(), 'claim')
        .mockRejectedValue(new Error('log store down'));
      try {
        for (let receive = 1; receive <= 5; receive++)
          await expect(
            host.handleRecord(JSON.stringify(m), receive),
          ).rejects.toThrow('log store down');
      } finally {
        down.mockRestore(); // L-013
      }
      expect(receiver.connections).toBe(0);
      expect(await state(m)).toBe('queued');

      // the operator redrives the very message
      await expect(host.handleRecord(JSON.stringify(m), 1)).resolves.toBe(
        'delivered',
      );
      await expect(host.handleRecord(JSON.stringify(m), 2)).resolves.toBe(
        'skipped',
      );
      expect(receiver.requests).toHaveLength(1);

      // the queue's redrive policy sends a message to the dead-letter lane on the fifth receive
      const conf = readFileSync(
        join(__dirname, '../../../../../infra/docker/elasticmq/elasticmq.conf'),
        'utf8',
      );
      expect(conf).toMatch(
        /"webhook-deliveries\.fifo"[^\n]*deadLettersQueue \{ name = "webhook-deliveries-dlq\.fifo", maxReceiveCount = 5 \}/,
      );
    });
  });

  describe('circuit breaker (AS-47, AS-49)', () => {
    it('S43 AS-47: five failures open the breaker; no request while open; after the minute one probe goes out for two concurrent deliveries (20 rounds); a successful probe closes it; another endpoint is untouched', async () => {
      const other = await t.seedWorld();
      const bad = await setup();
      bad.receiver.respondWith({ status: 500 });
      const good = await setup(other);
      for (let i = 0; i < 5; i++) {
        const m = await flow.route(w, bad.e.id);
        expect(await flow.lane.run(m)).toBe('redeliver');
      }
      let state5 = await breaker().get(bad.e.id);
      expect(state5.consecutiveFailures).toBe(5);
      expect(state5.openUntil).toBe(t.clock.now().getTime() + MIN);

      // open: nothing is sent, the delivery waits for the close time with its attempt number unchanged
      const waiting = await flow.route(w, bad.e.id);
      const before = bad.receiver.requests.length;
      expect(await flow.lane.run(waiting)).toBe('breaker_skipped');
      expect(bad.receiver.requests).toHaveLength(before);
      expect(await flow.delivery(waiting)).toMatchObject({
        state: 'retry_scheduled',
        attempt: 1,
      });
      const [job] = await flow.lane.retryJobs(bad.e.id, waiting.eventId);
      expect(job.runAt.getTime()).toBe(state5.openUntil);
      const okMessage = await flow.route(other, good.e.id);
      expect(await flow.lane.run(okMessage)).toBe('delivered'); // E3 untouched

      // half-open, 20 rounds: two deliveries at the same moment, exactly one probe
      for (let round = 0; round < 20; round++) {
        state5 = await breaker().get(bad.e.id);
        t.clock.set(new Date(state5.openUntil! + 1));
        const [m1, m2] = [
          await flow.route(w, bad.e.id),
          await flow.route(w, bad.e.id),
        ];
        const sentBefore = bad.receiver.requests.length;
        const results = await Promise.all([
          flow.lane.run(m1),
          flow.lane.run(m2),
        ]);
        expect(bad.receiver.requests.length).toBe(sentBefore + 1);
        expect(results.filter((r) => r === 'breaker_skipped')).toHaveLength(1);
        expect(results.filter((r) => r === 'redeliver')).toHaveLength(1);
      }
      // a failed probe doubles the closed time up to 30 minutes
      const last = await breaker().get(bad.e.id);
      expect(last.consecutiveFailures).toBe(5 + 20);
      expect(last.openUntil! - t.clock.now().getTime()).toBe(30 * MIN);

      // a successful probe closes it and resets the count
      bad.receiver.respondWith({ status: 200 });
      t.clock.set(new Date(last.openUntil! + 1));
      const probe = await flow.route(w, bad.e.id);
      expect(await flow.lane.run(probe)).toBe('delivered');
      expect(await breaker().get(bad.e.id)).toMatchObject({
        consecutiveFailures: 0,
        openUntil: null,
      });
    }, 120_000);

    it('S43 AS-49: with the breaker store down deliveries go out as if it were closed, the degradation is counted and nothing is lost or doubled', async () => {
      const redis = t.app.get(RedisService).client;
      const { receiver, e } = await setup();
      const good = await flow.route(w, e.id);
      const failing = await flow.route(w, e.id);
      const down = ['hgetall', 'exists', 'hincrby', 'del', 'set'].map((m) =>
        jest
          .spyOn(redis, m as 'get')
          .mockRejectedValue(new Error('breaker store down')),
      );
      const before =
        MetricsRegistry.value('webhook_breaker_degraded_total') ?? 0;
      try {
        expect(await flow.lane.run(good)).toBe('delivered');
        receiver.respondWith({ status: 500 });
        expect(await flow.lane.run(failing)).toBe('redeliver');
      } finally {
        for (const spy of down) spy.mockRestore(); // L-013
      }

      expect(
        MetricsRegistry.value('webhook_breaker_degraded_total'),
      ).toBeGreaterThan(before);
      expect(receiver.requests.map((r) => r.eventId)).toEqual([
        good.eventId,
        failing.eventId,
      ]);
      expect(await state(good)).toBe('delivered');
      expect(await state(failing)).toBe('retry_scheduled');
      expect(await breaker().get(e.id)).toMatchObject({ openUntil: null });
    });
  });

  describe('disable and delete (AS-50)', () => {
    it('S43 AS-50: after a disable none of the queued deliveries is sent and each becomes cancelled; re-enabling resends nothing; the same after a delete', async () => {
      const { receiver, e } = await setup();
      const queued: DeliveryMessage[] = [];
      for (let i = 0; i < 5; i++) queued.push(await flow.route(w, e.id));

      const off = await t
        .as(w.owner)
        .post(`${t.base(w)}/${e.id}/disable`)
        .send({});
      expect(off.status).toBe(200);
      for (const m of queued) expect(await flow.lane.run(m)).toBe('cancelled');
      expect(receiver.connections).toBe(0);
      for (const m of queued)
        expect(await flow.delivery(m)).toMatchObject({
          state: 'cancelled',
          cancelReason: 'endpoint_disabled',
        });
      const on = await t
        .as(w.owner)
        .post(`${t.base(w)}/${e.id}/enable`)
        .send({});
      expect(on.status).toBe(200);
      for (const m of queued) expect(await flow.lane.run(m, 2)).toBe('skipped');
      expect(receiver.connections).toBe(0);

      const doomed: DeliveryMessage[] = [];
      for (let i = 0; i < 3; i++) doomed.push(await flow.route(w, e.id));
      const gone = await t.as(w.owner).delete(`${t.base(w)}/${e.id}`);
      expect(gone.status).toBe(204);
      for (const m of doomed) expect(await flow.lane.run(m)).toBe('cancelled');
      expect(receiver.connections).toBe(0);
      for (const m of doomed)
        expect(await flow.delivery(m)).toMatchObject({
          state: 'cancelled',
          cancelReason: 'endpoint_deleted',
        });
    });
  });

  describe('shutdown (AS-54)', () => {
    it('S43 AS-54: on shutdown the worker stops taking messages, lets the attempt in flight finish, records it once, and only then completes', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 200, delayMs: 2_000 });
      const inFlight = await flow.route(w, e.id);
      const next = await flow.route(w, e.id);
      let attemptDone = false;
      const running = workers()
        .handle(inFlight, 1)
        .then((r) => {
          attemptDone = true;
          return r;
        });
      await waitFor(() => receiver.requests.length === 1, 'the request');

      let stopped = false;
      const shutdown = workers()
        .shutdown()
        .then(() => {
          stopped = true;
          expect(attemptDone).toBe(true);
        });
      queue.sent.push({ queue: WEBHOOK_QUEUE, body: next });
      await queue.drain(WEBHOOK_QUEUE); // intake is closed: the handler is gone
      expect(receiver.requests).toHaveLength(1);
      expect(stopped).toBe(false);

      expect(await running).toBe('delivered');
      await shutdown;
      expect(await flow.attempts(e.id, inFlight.eventId)).toHaveLength(1);
      expect(await state(inFlight)).toBe('delivered');
      expect(await state(next)).toBe('queued');
    });
  });
});
