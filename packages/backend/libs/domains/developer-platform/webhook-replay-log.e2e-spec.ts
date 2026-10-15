import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { v7 as uuidv7 } from 'uuid';
import {
  webhookAttemptPageSchema,
  webhookDeliveryAcceptedSchema,
  webhookEventDetailSchema,
  webhookMessageSchema,
} from '@marketplace-sandbox/contracts';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { verifyWebhook } from './domain/signature';
import {
  BreakerStore,
  DeliveryQueue,
  type DeliveryMessage,
} from './domain/webhook-ports';
import {
  createWebhookKit,
  waitFor,
  type WebhookKit,
  type WebhookWorld,
} from './testing/webhook-e2e.fixture';
import { createFlow, type Flow } from './testing/webhook-flow';
import { clearRateLimits } from './testing/public-api-kit';
import { WebhooksProjectorModule } from './webhooks-projector.module';
import { WebhooksWorkerModule } from './webhooks-worker.module';

const SEC = 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('Webhooks: delivery log, replay and test events', () => {
  let queue: InMemoryTaskQueue;
  let t: WebhookKit;
  let flow: Flow;
  let w: WebhookWorld;

  beforeAll(async () => {
    queue = new InMemoryTaskQueue();
    t = await createWebhookKit({
      extraImports: [WebhooksProjectorModule, WebhooksWorkerModule],
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

  const breaker = () => t.app.get(BreakerStore, { strict: false });
  const base = (world: WebhookWorld = w) => t.base(world);
  const setup = async (world: WebhookWorld = w) => {
    const receiver = await t.startReceiver();
    const e = await flow.endpoint(world, receiver.url());
    return { receiver, e };
  };
  const attemptsOf = (
    endpointId: string,
    query = '',
    world: WebhookWorld = w,
  ) => t.as(world.owner).get(`${base(world)}/${endpointId}/attempts${query}`);
  const replay = (
    endpointId: string,
    eventId: string,
    key: string | null,
    world: WebhookWorld = w,
  ) => {
    const req = t
      .as(world.owner)
      .post(`${base(world)}/${endpointId}/events/${eventId}/replay`);
    return (key === null ? req : req.set('Idempotency-Key', key)).send({});
  };
  const ping = (endpointId: string, world: WebhookWorld = w) =>
    t
      .as(world.owner)
      .post(`${base(world)}/${endpointId}/ping`)
      .send({});
  /** One routed event delivered to the endpoint (the clock moves one second first, so attempts have distinct times). */
  const deliver = async (endpointId: string, world: WebhookWorld = w) => {
    t.clock.advance(SEC);
    const m = await flow.route(world, endpointId);
    await flow.lane.run(m);
    return m;
  };
  const lastKey = () => `key-${uuidv7()}`;
  /** A problem body without the parts that are per request. */
  const stable = (body: Record<string, unknown>) => {
    const { instance, requestId, ...rest } = body;
    void instance;
    void requestId;
    return rest;
  };
  const replayMessages = (endpointId: string) =>
    flow.lane.pending(endpointId).filter((m) => m.kind === 'replay');

  describe('attempt log (AS-60)', () => {
    it('S43 AS-60: 60 attempts are read newest first in pages of 25 with a cursor that survives a concurrent insert; filters work; other endpoints, secrets and signatures never show', async () => {
      const { receiver, e } = await setup();
      const other = await setup();
      for (let i = 0; i < 60; i++) {
        receiver.respondWith({ status: i % 3 === 2 ? 500 : 200 });
        await deliver(e.id);
      }
      await deliver(other.e.id);
      const stored = (await flow.attempts(e.id)).map((a) => a.attemptId);
      expect(stored).toHaveLength(60);

      const first = await attemptsOf(e.id, '?limit=25');
      expect(first.status).toBe(200);
      const page1 = webhookAttemptPageSchema.parse(first.body);
      expect(page1.items).toHaveLength(25);
      expect(page1.nextCursor).not.toBeNull();
      expect(page1.items[0]).toEqual(
        expect.objectContaining({
          deliveryId: expect.any(String),
          eventId: expect.stringMatching(/^evt_/),
          type: 'order.paid',
          attempt: 1,
          durationMs: expect.any(Number),
          replay: false,
        }),
      );

      // an attempt that arrives between the two page calls shifts nothing
      receiver.respondWith({ status: 200 });
      await deliver(e.id);
      const second = webhookAttemptPageSchema.parse(
        (await attemptsOf(e.id, `?limit=25&cursor=${page1.nextCursor}`)).body,
      );
      const third = webhookAttemptPageSchema.parse(
        (await attemptsOf(e.id, `?limit=25&cursor=${second.nextCursor}`)).body,
      );
      expect(third.nextCursor).toBeNull();
      const walked = [...page1.items, ...second.items, ...third.items];
      expect(walked).toHaveLength(60);
      expect(new Set(walked.map((a) => a.attemptId)).size).toBe(60);
      expect(new Set(walked.map((a) => a.attemptId))).toEqual(new Set(stored));
      for (let i = 1; i < walked.length; i++) {
        const [a, b] = [walked[i - 1], walked[i]];
        expect(
          a.startedAt > b.startedAt ||
            (a.startedAt === b.startedAt && a.attemptId > b.attemptId),
        ).toBe(true);
      }
      // the new attempt is the head of a fresh read
      const fresh = webhookAttemptPageSchema.parse(
        (await attemptsOf(e.id, '?limit=1')).body,
      );
      expect(stored).not.toContain(fresh.items[0].attemptId);

      // filters
      const failed = webhookAttemptPageSchema.parse(
        (await attemptsOf(e.id, '?ok=false&limit=100')).body,
      );
      expect(failed.items).toHaveLength(20);
      expect(failed.items.every((a) => !a.ok && a.status === 500)).toBe(true);
      const succeeded = webhookAttemptPageSchema.parse(
        (await attemptsOf(e.id, '?ok=true&limit=100')).body,
      );
      expect(succeeded.items).toHaveLength(41);
      const wanted = walked[7].eventId;
      const byEvent = webhookAttemptPageSchema.parse(
        (await attemptsOf(e.id, `?eventId=${wanted}`)).body,
      );
      expect(byEvent.items.map((a) => a.eventId)).toEqual([wanted]);

      // another endpoint's attempts never appear, and nothing sensitive does
      const otherIds = (await flow.attempts(other.e.id)).map(
        (a) => a.attemptId,
      );
      expect(otherIds).toHaveLength(1);
      const everything = JSON.stringify([
        first.body,
        ...(await Promise.all([attemptsOf(e.id, '?limit=100')])).map(
          (r) => r.body,
        ),
      ]);
      expect(everything).not.toContain(otherIds[0]);
      for (const secret of [
        e.secret,
        other.e.secret,
        'Marketplace-Signature',
        'v1=',
        'secretSealed',
      ])
        expect(everything).not.toContain(secret);
    }, 120_000);

    it('S43 AS-60: a failed attempt shows its closed-vocabulary error and a snippet; a request with a bad cursor, limit or filter is a 400 problem with a stable code; an unknown or foreign endpoint is the same 404', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 500, body: 'upstream exploded' });
      await deliver(e.id);
      const [failed] = webhookAttemptPageSchema.parse(
        (await attemptsOf(e.id)).body,
      ).items;
      expect(failed).toMatchObject({
        ok: false,
        status: 500,
        responseSnippet: 'upstream exploded',
      });
      expect(failed.error).toBeUndefined();

      const badCursor = await attemptsOf(e.id, '?cursor=not-a-cursor');
      expect(badCursor.status).toBe(400);
      expect(badCursor.body.code).toBe('invalid_cursor');
      expect((await attemptsOf(e.id, '?limit=0')).status).toBe(400);
      expect((await attemptsOf(e.id, '?limit=101')).status).toBe(400);
      expect((await attemptsOf(e.id, '?ok=maybe')).status).toBe(400);
      expect((await attemptsOf(e.id, '?extra=1')).status).toBe(400);

      const w2 = await t.seedWorld();
      const foreign = await setup(w2);
      const cross = await attemptsOf(foreign.e.id);
      const unknown = await attemptsOf(uuidv7());
      expect(cross.status).toBe(404);
      expect(cross.body.code).toBe('webhook_endpoint_not_found');
      expect(stable(cross.body)).toEqual(stable(unknown.body));
      // the owner of the foreign endpoint reads it
      expect((await attemptsOf(foreign.e.id, '', w2)).status).toBe(200);
    });

    it('S43 AS-60: attempts older than 30 days are not returned although the store still holds them', async () => {
      const { e } = await setup();
      const m = await deliver(e.id);
      const startedAt = t.clock.now();

      t.clock.set(new Date(startedAt.getTime() + 30 * DAY - SEC));
      await t.reauth(w.owner);
      expect(
        webhookAttemptPageSchema.parse((await attemptsOf(e.id)).body).items,
      ).toHaveLength(1);

      t.clock.set(new Date(startedAt.getTime() + 30 * DAY));
      await t.reauth(w.owner);
      expect(
        webhookAttemptPageSchema.parse((await attemptsOf(e.id)).body).items,
      ).toHaveLength(0);

      const dynamo = t.app.get(DynamoService);
      const scan = await dynamo.doc.send(
        new ScanCommand({
          TableName: dynamo.table('WebhookAttempts'),
          FilterExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `endpoint#${e.id}` },
        }),
      );
      expect(scan.Items?.length).toBeGreaterThanOrEqual(2); // the delivery and its attempt are still physically there
      expect(m.eventId).toMatch(/^evt_/);
    });
  });

  describe('event detail (AS-61)', () => {
    it('S43 AS-61: a delivered event is returned with its state, attempt count and parsed body; unknown, foreign, other-endpoint and expired events are one 404', async () => {
      const { e } = await setup();
      // a sibling that does not subscribe to orders: it was never sent this event
      const second = {
        e: await flow.endpoint(w, (await t.startReceiver()).url(), {
          events: ['payout.paid'],
        }),
      };
      const m = await deliver(e.id);
      const stored = await flow.delivery(m);

      const res = await t
        .as(w.owner)
        .get(`${base()}/${e.id}/events/${m.eventId}`);
      expect(res.status).toBe(200);
      const detail = webhookEventDetailSchema.parse(res.body);
      expect(detail).toMatchObject({
        eventId: m.eventId,
        type: 'order.paid',
        state: 'delivered',
        attempts: 1,
      });
      expect(detail.createdAt).toBe(stored.createdAt.toISOString());
      expect(detail.body).toEqual(JSON.parse(stored.body));
      expect(webhookMessageSchema.parse(detail.body).id).toBe(m.eventId);

      const unknown = await t
        .as(w.owner)
        .get(`${base()}/${e.id}/events/evt_${'0'.repeat(32)}`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('webhook_event_not_found');
      const otherEndpoint = await t
        .as(w.owner)
        .get(`${base()}/${second.e.id}/events/${m.eventId}`);
      expect(otherEndpoint.status).toBe(404);
      expect(stable(otherEndpoint.body)).toEqual(stable(unknown.body));

      const w2 = await t.seedWorld();
      const foreign = await setup(w2);
      const foreignEvent = await t
        .as(w2.owner)
        .get(`${base(w2)}/${foreign.e.id}/events/${m.eventId}`);
      expect(foreignEvent.status).toBe(404);
      expect(stable(foreignEvent.body)).toEqual(stable(unknown.body));
      const foreignEndpoint = await t
        .as(w2.owner)
        .get(`${base(w2)}/${e.id}/events/${m.eventId}`);
      const unknownEndpoint = await t
        .as(w2.owner)
        .get(`${base(w2)}/${uuidv7()}/events/${m.eventId}`);
      expect(foreignEndpoint.status).toBe(404);
      expect(foreignEndpoint.body.code).toBe('webhook_endpoint_not_found');
      expect(stable(foreignEndpoint.body)).toEqual(
        stable(unknownEndpoint.body),
      );

      t.clock.set(new Date(stored.createdAt.getTime() + 30 * DAY));
      await t.reauth(w.owner);
      const expired = await t
        .as(w.owner)
        .get(`${base()}/${e.id}/events/${m.eventId}`);
      expect(expired.status).toBe(404);
      expect(stable(expired.body)).toEqual(stable(unknown.body));
    });

    it('S43 AS-61: an event that is still being retried shows its state and the attempts so far', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 500 });
      const m = await deliver(e.id);
      const res = await t
        .as(w.owner)
        .get(`${base()}/${e.id}/events/${m.eventId}`);
      expect(webhookEventDetailSchema.parse(res.body)).toMatchObject({
        state: 'retry_scheduled',
        attempts: 1,
      });
    });
  });

  describe('replay (AS-62, AS-64)', () => {
    it('S43 AS-62: a replay is accepted at once without calling the receiver; the worker then sends the byte-identical stored body once with a fresh signature, a new delivery id and the replay header, and logs it as a replay', async () => {
      const { receiver, e } = await setup();
      const m = await deliver(e.id);
      const original = await flow.delivery(m);
      const sent = receiver.requests[0];
      receiver.clear();
      t.clock.advance(5 * SEC);

      const res = await replay(e.id, m.eventId, lastKey());
      expect(res.status).toBe(202);
      expect(webhookDeliveryAcceptedSchema.parse(res.body)).toEqual({
        deliveryId: expect.any(String),
        eventId: m.eventId,
        endpointId: e.id,
        state: 'queued',
      });
      expect(receiver.requests).toHaveLength(0); // nothing is sent inside the HTTP call
      const [message] = replayMessages(e.id);
      expect(message).toMatchObject({
        endpointId: e.id,
        eventId: m.eventId,
        deliveryId: res.body.deliveryId,
        kind: 'replay',
        attempt: 1,
      });

      expect(await flow.lane.run(message)).toBe('delivered');
      expect(receiver.requests).toHaveLength(1);
      const [request] = receiver.requests;
      expect(request.body).toBe(original.body);
      expect(request.eventId).toBe(m.eventId);
      expect(request.deliveryId).toBe(res.body.deliveryId);
      expect(request.deliveryId).not.toBe(m.deliveryId);
      expect(request.replay).toBe(true);
      expect(request.attempt).toBe(1);
      expect(request.signature).not.toBe(sent.signature);
      expect(
        verifyWebhook(request.body, request.signature, e.secret, {
          now: t.clock.now().getTime(),
        }),
      ).toBe(true);
      expect(request.signature).toContain(
        `t=${Math.floor(t.clock.now().getTime() / 1000)}`,
      );

      const items = webhookAttemptPageSchema.parse(
        (await attemptsOf(e.id, `?eventId=${m.eventId}`)).body,
      ).items;
      expect(items.map((a) => a.replay)).toEqual([true, false]);
      expect(items[0]).toMatchObject({
        deliveryId: res.body.deliveryId,
        ok: true,
        status: 200,
      });
      // the original delivery keeps its own story
      expect((await flow.delivery(m)).state).toBe('delivered');
      expect(
        webhookEventDetailSchema.parse(
          (await t.as(w.owner).get(`${base()}/${e.id}/events/${m.eventId}`))
            .body,
        ).attempts,
      ).toBe(2);
    });

    it('S43 AS-62: a failing replay is one attempt with no retry and no effect on the failure window, the breaker or auto-disable', async () => {
      const { receiver, e } = await setup();
      const m = await deliver(e.id);
      // the endpoint is, on paper, past its failure window: a failing real attempt would switch it off
      await t.exec(
        `UPDATE "WebhookEndpoint" SET "failingSince" = :since WHERE id = :id`,
        { id: e.id, since: new Date(t.clock.now().getTime() - 4 * DAY) },
      );
      receiver.respondWith({ status: 500 });
      const before = receiver.requests.length;

      for (let i = 0; i < 6; i++) {
        const res = await replay(e.id, m.eventId, lastKey());
        expect(res.status).toBe(202);
        const [message] = replayMessages(e.id);
        queue.sent.splice(0, queue.sent.length);
        expect(await flow.lane.run(message)).toBe('failed');
        expect((await flow.lane.retryJobs(e.id)).length).toBe(0);
        expect(flow.lane.pending(e.id)).toHaveLength(0);
      }

      expect(receiver.requests.length - before).toBe(6);
      const [row] = await t.rows<{
        status: string;
        failingSince: Date | null;
      }>(
        `SELECT status, "failingSince" FROM "WebhookEndpoint" WHERE id = :id`,
        { id: e.id },
      );
      expect(row.status).toBe('enabled');
      expect(row.failingSince?.getTime()).toBe(
        t.clock.now().getTime() - 4 * DAY,
      );
      expect(await breaker().get(e.id)).toMatchObject({
        consecutiveFailures: 0,
        openUntil: null,
      });
      expect(
        await t.outboxEvents('developerplatform.webhook_endpoint_disabled', {
          aggregateId: e.id,
        }),
      ).toHaveLength(0);
      const items = webhookAttemptPageSchema.parse(
        (await attemptsOf(e.id, '?ok=false&limit=100')).body,
      ).items;
      expect(items).toHaveLength(6);
      expect(items.every((a) => a.replay && a.status === 500)).toBe(true);
    });

    it('S43 AS-62: replays are limited to 30 a minute per shop (webhooks.replay.shop)', async () => {
      const { e } = await setup();
      const m = await deliver(e.id);
      for (let i = 0; i < 30; i++)
        expect((await replay(e.id, m.eventId, lastKey())).status).toBe(202);
      const limited = await replay(e.id, m.eventId, lastKey());
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
    });

    it('S43 AS-64: a disabled endpoint refuses replay and ping with 409; unknown, expired and foreign events are the same 404; a type the endpoint no longer subscribes to can still be replayed', async () => {
      const { e } = await setup();
      const m = await deliver(e.id);

      // an unsubscribed type is replayable
      const patched = await t
        .as(w.owner)
        .patch(`${base()}/${e.id}`)
        .send({ events: ['payout.paid'] });
      expect(patched.status).toBe(200);
      expect((await replay(e.id, m.eventId, lastKey())).status).toBe(202);

      const unknown = await replay(e.id, `evt_${'1'.repeat(32)}`, lastKey());
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('webhook_event_not_found');
      const w2 = await t.seedWorld();
      const foreign = await setup(w2);
      const crossEvent = await replay(foreign.e.id, m.eventId, lastKey(), w2);
      expect(crossEvent.status).toBe(404);
      expect(crossEvent.body.code).toBe('webhook_event_not_found');
      expect(stable(crossEvent.body)).toEqual(stable(unknown.body));
      const crossEndpoint = await replay(e.id, m.eventId, lastKey(), w2);
      const unknownEndpoint = await replay(uuidv7(), m.eventId, lastKey(), w2);
      expect(crossEndpoint.status).toBe(404);
      expect(crossEndpoint.body.code).toBe('webhook_endpoint_not_found');
      expect(stable(crossEndpoint.body)).toEqual(stable(unknownEndpoint.body));

      const off = await t
        .as(w.owner)
        .post(`${base()}/${e.id}/disable`)
        .send({});
      expect(off.status).toBe(200);
      const replayOff = await replay(e.id, m.eventId, lastKey());
      expect(replayOff.status).toBe(409);
      expect(replayOff.body.code).toBe('endpoint_disabled');
      const pingOff = await ping(e.id);
      expect(pingOff.status).toBe(409);
      expect(pingOff.body.code).toBe('endpoint_disabled');
      await t.as(w.owner).post(`${base()}/${e.id}/enable`).send({});

      t.clock.set(new Date(t.clock.now().getTime() + 30 * DAY));
      await t.reauth(w.owner);
      const expired = await replay(e.id, m.eventId, lastKey());
      expect(expired.status).toBe(404);
      expect(expired.body.code).toBe('webhook_event_not_found');
    });
  });

  describe('replay idempotency (AS-63)', () => {
    it('S43 AS-63: the same key repeated answers the same 202 with Idempotent-Replayed and makes one replay delivery; another event under the key is 422 idempotency_key_reuse; no key is 422 idempotency_key_required', async () => {
      const { e } = await setup();
      const m = await deliver(e.id);
      const other = await deliver(e.id);
      const key = lastKey();

      const first = await replay(e.id, m.eventId, key);
      expect(first.status).toBe(202);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      const again = await replay(e.id, m.eventId, key);
      expect(again.status).toBe(202);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(replayMessages(e.id)).toHaveLength(1);

      const reuse = await replay(e.id, other.eventId, key);
      expect(reuse.status).toBe(422);
      expect(reuse.body.code).toBe('idempotency_key_reuse');
      const missing = await replay(e.id, m.eventId, null);
      expect(missing.status).toBe(422);
      expect(missing.body.code).toBe('idempotency_key_required');
      expect(replayMessages(e.id)).toHaveLength(1);
    });

    it('S43 AS-63: 20 rounds of 20 simultaneous calls with one key make exactly one replay; the others are 409 idempotency_in_flight while it runs and the same answer afterwards', async () => {
      const { e } = await setup();
      const m = await deliver(e.id);
      const queueOf = t.app.get(DeliveryQueue, { strict: false });
      const real = queueOf.enqueue.bind(queueOf);
      for (let round = 0; round < 20; round++) {
        const key = lastKey();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let entered = 0;
        const hold = jest
          .spyOn(queueOf, 'enqueue')
          .mockImplementation(async (message: DeliveryMessage) => {
            entered++;
            await gate;
            return real(message);
          });
        try {
          const settled: number[] = [];
          const calls = Array.from({ length: 20 }, () =>
            replay(e.id, m.eventId, key).then((res) => {
              settled.push(res.status);
              return res;
            }),
          );
          await waitFor(
            () => settled.length === 19 && entered === 1,
            'the 19 refusals while the first call is held',
          );
          release();
          const results = await Promise.all(calls);
          const accepted = results.filter((r) => r.status === 202);
          const refused = results.filter((r) => r.status === 409);
          expect(accepted).toHaveLength(1);
          expect(refused).toHaveLength(19);
          expect(
            refused.every((r) => r.body.code === 'idempotency_in_flight'),
          ).toBe(true);
          expect(refused[0].headers['retry-after']).toBeDefined();
        } finally {
          hold.mockRestore(); // L-013
        }
        const after = await replay(e.id, m.eventId, key);
        expect(after.status).toBe(202);
        expect(after.headers['idempotent-replayed']).toBe('true');
        expect(
          replayMessages(e.id).filter(
            (x) => x.deliveryId === after.body.deliveryId,
          ),
        ).toHaveLength(1);
        queue.sent.length = 0;
        await clearRateLimits(t.app); // 20 rounds exceed the per-minute replay limit by design
      }
    }, 180_000);

    it('S43 AS-63: the key is remembered for 24 hours and accepted anew after that', async () => {
      const { e } = await setup();
      const m = await deliver(e.id);
      const key = lastKey();
      const first = await replay(e.id, m.eventId, key);
      expect(first.status).toBe(202);

      t.clock.advance(DAY - SEC);
      await t.reauth(w.owner);
      const still = await replay(e.id, m.eventId, key);
      expect(still.headers['idempotent-replayed']).toBe('true');
      expect(still.body).toEqual(first.body);

      t.clock.advance(SEC);
      await t.reauth(w.owner);
      const anew = await replay(e.id, m.eventId, key);
      expect(anew.status).toBe(202);
      expect(anew.headers['idempotent-replayed']).toBeUndefined();
      expect(anew.body.deliveryId).not.toBe(first.body.deliveryId);
      expect(replayMessages(e.id)).toHaveLength(2);
    });

    it('S43 AS-63: a replay that failed to start releases its key, so the same key can be used again', async () => {
      const { e } = await setup();
      const m = await deliver(e.id);
      const key = lastKey();
      const queueOf = t.app.get(DeliveryQueue, { strict: false });
      const down = jest
        .spyOn(queueOf, 'enqueue')
        .mockRejectedValue(new Error('queue down'));
      try {
        const failed = await replay(e.id, m.eventId, key);
        expect(failed.status).toBe(503);
        expect(failed.body.code).toBe('service_unavailable');
      } finally {
        down.mockRestore(); // L-013
      }
      const retried = await replay(e.id, m.eventId, key);
      expect(retried.status).toBe(202);
      expect(retried.headers['idempotent-replayed']).toBeUndefined();
    });
  });

  describe('test event (AS-65)', () => {
    it('S43 AS-65: a ping goes to that endpoint only, signed and versioned, through its ordered lane, once and without health effects, although the endpoint is not subscribed to it', async () => {
      const { receiver, e } = await setup();
      const sibling = await setup();
      await t
        .as(w.owner)
        .patch(`${base()}/${sibling.e.id}`)
        .send({ events: ['webhook.ping'] });
      const endpoint = (await t.as(w.owner).get(`${base()}/${e.id}`)).body;
      expect(endpoint.events).not.toContain('webhook.ping');

      const res = await ping(e.id);
      expect(res.status).toBe(202);
      const accepted = webhookDeliveryAcceptedSchema.parse(res.body);
      expect(accepted).toMatchObject({ endpointId: e.id, state: 'queued' });
      expect(accepted.eventId).toMatch(/^evt_[0-9a-f]{32}$/);
      expect(receiver.requests).toHaveLength(0);
      const messages = flow.lane.pending();
      expect(messages).toEqual([
        {
          endpointId: e.id,
          eventId: accepted.eventId,
          deliveryId: accepted.deliveryId,
          kind: 'ping',
          attempt: 1,
        },
      ]);

      expect(await flow.lane.run(messages[0])).toBe('delivered');
      expect(receiver.requests).toHaveLength(1);
      const [request] = receiver.requests;
      const body = webhookMessageSchema.parse(JSON.parse(request.body));
      expect(body).toEqual({
        id: accepted.eventId,
        object: 'event',
        type: 'webhook.ping',
        created: t.clock.now().toISOString(),
        api_version: endpoint.apiVersion,
        resource_version: null,
        data: { object: { object: 'ping' } },
      });
      expect(request.eventType).toBe('webhook.ping');
      expect(request.deliveryId).toBe(accepted.deliveryId);
      expect(request.attempt).toBe(1);
      expect(
        verifyWebhook(request.body, request.signature, e.secret, {
          now: t.clock.now().getTime(),
        }),
      ).toBe(true);
      expect(sibling.receiver.requests).toHaveLength(0);

      // another ping is a new event
      const next = await ping(e.id);
      expect(next.body.eventId).not.toBe(accepted.eventId);
      const items = webhookAttemptPageSchema.parse(
        (await attemptsOf(e.id)).body,
      ).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ type: 'webhook.ping', replay: false });
    });

    it('S43 AS-65: a failing ping is one attempt: no retry, no failure window, no breaker count', async () => {
      const { receiver, e } = await setup();
      receiver.respondWith({ status: 500 });
      for (let i = 0; i < 6; i++) {
        const res = await ping(e.id);
        expect(res.status).toBe(202);
        const [message] = flow.lane.take(e.id);
        expect(await flow.lane.run(message)).toBe('failed');
        expect((await flow.delivery(message)).state).toBe('failed');
      }
      expect((await flow.lane.retryJobs(e.id)).length).toBe(0);
      expect(await flow.failingSince(e.id)).toBeNull();
      expect(await breaker().get(e.id)).toMatchObject({
        consecutiveFailures: 0,
        openUntil: null,
      });
    });

    it('S43 AS-65: more than 10 pings a minute to one endpoint are 429 rate_limited with Retry-After; another endpoint is not affected', async () => {
      const { e } = await setup();
      const other = await setup();
      for (let i = 0; i < 10; i++) expect((await ping(e.id)).status).toBe(202);
      const limited = await ping(e.id);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
      expect((await ping(other.e.id)).status).toBe(202);
    });

    it('S43 AS-65: pinging an unknown or foreign endpoint is the same 404', async () => {
      const w2 = await t.seedWorld();
      const foreign = await setup(w2);
      const cross = await ping(foreign.e.id);
      const unknown = await ping(uuidv7());
      expect(cross.status).toBe(404);
      expect(cross.body.code).toBe('webhook_endpoint_not_found');
      expect(stable(cross.body)).toEqual(stable(unknown.body));
    });
  });
});
