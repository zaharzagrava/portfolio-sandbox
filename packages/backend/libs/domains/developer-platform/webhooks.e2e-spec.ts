import { createHmac } from 'node:crypto';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  createdWebhookEndpointSchema,
  rotatedWebhookSecretSchema,
  WEBHOOK_SECRET_PATTERN,
  webhookEndpointSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { SecretBox } from '@app/domains/identity';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { verifyWebhook } from './domain/signature';
import type { DeliveryMessage } from './domain/webhook-ports';
import { createFlow, type Flow } from './testing/webhook-flow';
import { WebhooksProjectorModule } from './webhooks-projector.module';
import { WebhooksWorkerModule } from './webhooks-worker.module';
import {
  createWebhookKit,
  FROZEN_NOW,
  type WebhookKit,
  type WebhookReceiver,
  type WebhookWorld,
} from './testing/webhook-e2e.fixture';
import { clearRateLimits } from './testing/public-api-kit';

/** Runs the rounds of a repeated test five at a time (each round uses data of its own). */
const eachRound = async (
  rounds: number,
  body: (round: number) => Promise<void>,
  size = 5,
): Promise<void> => {
  for (let from = 0; from < rounds; from += size)
    await Promise.all(
      Array.from({ length: Math.min(size, rounds - from) }, (_, k) =>
        body(from + k),
      ),
    );
};

const EVENT = 'developerplatform.webhook_endpoint_changed';
const HOUR = 3_600_000;

describe('Webhooks: signing and secret rotation', () => {
  let t: WebhookKit;
  let w: WebhookWorld;
  let receiver: WebhookReceiver;
  let queue: InMemoryTaskQueue;
  let flow: Flow;

  beforeAll(async () => {
    queue = new InMemoryTaskQueue();
    t = await createWebhookKit({
      structuredLogger: true,
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
    receiver = await t.startReceiver();
  });

  const base = () => t.base(w);
  const owner = () => t.as(w.owner);
  const create = async (url = receiver.url()) => {
    const res = await owner()
      .post(base())
      .send({ url, events: ['order.paid'] });
    expect(res.status).toBe(201);
    return createdWebhookEndpointSchema.parse(res.body);
  };
  const stored = async (id: string) =>
    (
      await t.rows<{
        secretSealed: string;
        previousSecretSealed: string | null;
        previousSecretExpiresAt: Date | null;
      }>(
        `SELECT "secretSealed", "previousSecretSealed", "previousSecretExpiresAt" FROM "WebhookEndpoint" WHERE id = :id`,
        { id },
      )
    )[0];
  const open = (sealed: string, endpointId: string) =>
    t.app.get(SecretBox).open(sealed, `webhook-endpoint:${endpointId}`);
  const history = (endpointId: string) =>
    t.rows<{ facet: string; fromValue: string | null; toValue: string | null }>(
      `SELECT facet, "fromValue", "toValue" FROM "WebhookEndpointHistory" WHERE "endpointId" = :endpointId ORDER BY "createdAt", id`,
      { endpointId },
    );
  /**
   * One real delivery through the production path to the receiver, as the clock stands: a paid order of the shop is
   * consumed by the routing consumer (the delivery record and the lane message are what production creates) and the
   * message goes through the worker's handler. Pass `message` to repeat an attempt of the same delivery.
   */
  const deliverTo = async (
    endpointId: string,
    message?: DeliveryMessage,
    receiveCount = 1,
  ) => {
    const queued = message ?? (await flow.route(w, endpointId));
    const before = receiver.requests.length;
    await flow.lane.run(queued, receiveCount);
    expect(receiver.requests.length).toBe(before + 1);
    return { request: receiver.requests[before], message: queued };
  };
  const v1s = (header: string | undefined) =>
    (header ?? '')
      .split(',')
      .filter((p) => p.startsWith('v1='))
      .map((p) => p.slice(3));
  const verifies = (
    request: { body: string; signature?: string },
    secret: string,
  ) =>
    verifyWebhook(request.body, request.signature, secret, {
      now: t.clock.now().getTime(),
    });

  describe('signing (AS-16)', () => {
    it('S43 AS-16: a real delivery carries t and an HMAC-SHA256 over "<t>.<exact body>" that the reference verifier accepts, and only for the right secret and bytes', async () => {
      const e = await create();
      const { request } = await deliverTo(e.id);

      const header = request.signature!;
      expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      const stamp = Math.floor(FROZEN_NOW.getTime() / 1000);
      expect(header.split(',')[0]).toBe(`t=${stamp}`);
      expect(v1s(header)).toEqual([
        createHmac('sha256', e.secret)
          .update(`${stamp}.${request.body}`)
          .digest('hex'),
      ]);
      expect(verifies(request, e.secret)).toBe(true);
      expect(verifies(request, `${e.secret}x`)).toBe(false);
      expect(
        verifies(
          { ...request, body: request.body.replace('"PAID"', '"PAYD"') },
          e.secret,
        ),
      ).toBe(false);
    });
  });

  describe('rotation (AS-18, AS-19, AS-21)', () => {
    it('S43 AS-18: rotating returns the new secret once with the expiry 24 h away; the next delivery carries two v1 values and verifies with both secrets', async () => {
      const e = await create();
      const res = await owner()
        .post(`${base()}/${e.id}/rotate-secret`)
        .send({});
      expect(res.status).toBe(201);
      const rotated = rotatedWebhookSecretSchema.parse(res.body);
      expect(rotated.secret).toMatch(WEBHOOK_SECRET_PATTERN);
      expect(rotated.secret).not.toBe(e.secret);
      expect(rotated.previousSecretExpiresAt).toBe(
        new Date(FROZEN_NOW.getTime() + 24 * HOUR).toISOString(),
      );

      const row = await stored(e.id);
      expect(open(row.secretSealed, e.id)).toBe(rotated.secret);
      expect(open(row.previousSecretSealed!, e.id)).toBe(e.secret);

      const read = await owner().get(`${base()}/${e.id}`).expect(200);
      expect(webhookEndpointSchema.parse(read.body)).toMatchObject({
        hasPreviousSecret: true,
        previousSecretExpiresAt: rotated.previousSecretExpiresAt,
      });
      expect(JSON.stringify(read.body)).not.toContain(rotated.secret);

      const { request } = await deliverTo(e.id);
      const sent = v1s(request.signature);
      expect(sent).toHaveLength(2);
      const stamp = Math.floor(FROZEN_NOW.getTime() / 1000);
      const mac = (secret: string) =>
        createHmac('sha256', secret)
          .update(`${stamp}.${request.body}`)
          .digest('hex');
      expect(sent).toEqual([mac(rotated.secret), mac(e.secret)]); // current first
      expect(verifies(request, e.secret)).toBe(true);
      expect(verifies(request, rotated.secret)).toBe(true);

      expect((await history(e.id)).map((h) => h.facet)).toEqual([
        'created',
        'secret_rotated',
      ]);
      const events = await t.outboxEvents(EVENT, { aggregateId: e.id });
      expect(events.map((x) => x.payload.change)).toEqual([
        'created',
        'secret_rotated',
      ]);
      for (const secret of [e.secret, rotated.secret])
        expect(JSON.stringify(events)).not.toContain(secret);
    });

    it('S43 AS-19: the previous secret signs at expiry minus 1 ms and stops signing at the expiry instant; a retry after the expiry is signed with the then-current set', async () => {
      const e = await create();
      const rotated = rotatedWebhookSecretSchema.parse(
        (await owner().post(`${base()}/${e.id}/rotate-secret`).send({})).body,
      );
      const expiry = new Date(rotated.previousSecretExpiresAt).getTime();

      t.clock.set(new Date(expiry - 1));
      receiver.respondWith({ status: 500 });
      const { request: firstAttempt, message } = await deliverTo(e.id);
      expect(v1s(firstAttempt.signature)).toHaveLength(2);
      expect(verifies(firstAttempt, e.secret)).toBe(true);

      t.clock.set(new Date(expiry));
      receiver.respondWith({ status: 200 });
      const { request: retried } = await deliverTo(e.id, message, 2); // the retry of the same delivery
      expect(v1s(retried.signature)).toHaveLength(1);
      expect(verifies(retried, rotated.secret)).toBe(true);
      expect(verifies(retried, e.secret)).toBe(false);
    });

    it('S43 AS-21: overlapHours 1 and 72 set the expiry exactly that far away; 0, 73, 1.5 and unknown properties are 400', async () => {
      const e = await create();
      for (const hours of [1, 72]) {
        const res = await owner()
          .post(`${base()}/${e.id}/rotate-secret`)
          .send({ overlapHours: hours });
        expect(res.status).toBe(201);
        expect(res.body.previousSecretExpiresAt).toBe(
          new Date(FROZEN_NOW.getTime() + hours * HOUR).toISOString(),
        );
        await owner()
          .post(`${base()}/${e.id}/expire-previous-secret`)
          .expect(200);
      }
      for (const body of [
        { overlapHours: 0 },
        { overlapHours: 73 },
        { overlapHours: 1.5 },
        { overlapHours: 'x' },
        { foo: 1 },
      ]) {
        const res = await owner()
          .post(`${base()}/${e.id}/rotate-secret`)
          .send(body);
        expect([res.status, res.body.code]).toEqual([400, 'validation_failed']);
      }
      expect((await stored(e.id)).previousSecretSealed).toBeNull();
    });
  });

  describe('rotation state rules (AS-20)', () => {
    it('S43 AS-20: rotating while the previous secret is valid is 409 rotation_in_progress and changes nothing; expire-previous-secret ends the overlap and allows a new rotation', async () => {
      const e = await create();
      const first = rotatedWebhookSecretSchema.parse(
        (await owner().post(`${base()}/${e.id}/rotate-secret`).send({})).body,
      );
      const before = await stored(e.id);
      const refused = await owner()
        .post(`${base()}/${e.id}/rotate-secret`)
        .send({});
      expect([refused.status, refused.body.code]).toEqual([
        409,
        'rotation_in_progress',
      ]);
      expect(await stored(e.id)).toEqual(before);

      const ended = await owner().post(
        `${base()}/${e.id}/expire-previous-secret`,
      );
      expect(ended.status).toBe(200);
      expect(webhookEndpointSchema.parse(ended.body)).toMatchObject({
        hasPreviousSecret: false,
        previousSecretExpiresAt: null,
      });
      const after = await stored(e.id);
      expect(after.previousSecretSealed).toBeNull();
      expect(open(after.secretSealed, e.id)).toBe(first.secret);

      const { request } = await deliverTo(e.id);
      expect(v1s(request.signature)).toHaveLength(1);
      expect(verifies(request, first.secret)).toBe(true);
      expect(verifies(request, e.secret)).toBe(false);

      const none = await owner().post(
        `${base()}/${e.id}/expire-previous-secret`,
      );
      expect([none.status, none.body.code]).toEqual([
        409,
        'no_previous_secret',
      ]);
      await owner()
        .post(`${base()}/${e.id}/rotate-secret`)
        .send({})
        .expect(201);

      expect((await history(e.id)).map((h) => h.facet)).toEqual([
        'created',
        'secret_rotated',
        'previous_secret_expired',
        'secret_rotated',
      ]);
      expect(
        (await t.outboxEvents(EVENT, { aggregateId: e.id })).map(
          (x) => x.payload.change,
        ),
      ).toEqual([
        'created',
        'secret_rotated',
        'previous_secret_expired',
        'secret_rotated',
      ]);
    });

    it('S43 AS-20: two concurrent rotations give exactly one 201 and one 409, and the stored secret is the winner’s (20 rounds)', async () => {
      await eachRound(20, async () => {
        await clearRateLimits(t.app);
        const e = await create(t.endpointUrl());
        const results = await Promise.all([
          owner().post(`${base()}/${e.id}/rotate-secret`).send({}),
          owner().post(`${base()}/${e.id}/rotate-secret`).send({}),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(results.find((r) => r.status === 409)!.body.code).toBe(
          'rotation_in_progress',
        );
        const winner = results.find((r) => r.status === 201)!;
        const row = await stored(e.id);
        expect(open(row.secretSealed, e.id)).toBe(winner.body.secret);
        expect(open(row.previousSecretSealed!, e.id)).toBe(e.secret);
        expect(
          (await history(e.id)).filter((h) => h.facet === 'secret_rotated'),
        ).toHaveLength(1);
        await owner().delete(`${base()}/${e.id}`).expect(204);
      });
    }, 120_000);
  });

  describe('hygiene (AS-22)', () => {
    it('S43 AS-22: no secret in any column, cache entry, outbox row, delivery-log item, log line or metric label; the sealed value does not open under another endpoint', async () => {
      const e = await create();
      const rotated = rotatedWebhookSecretSchema.parse(
        (await owner().post(`${base()}/${e.id}/rotate-secret`).send({})).body,
      );
      const other = await create(t.endpointUrl());
      const secrets = [e.secret, rotated.secret];
      await deliverTo(e.id);
      await owner().get(base()).expect(200);
      await owner().get(`${base()}/${e.id}`).expect(200);

      const places: Record<string, string> = {};
      places.endpointRows = JSON.stringify(
        await t.rows(`SELECT * FROM "WebhookEndpoint"`),
      );
      places.historyRows = JSON.stringify(
        await t.rows(`SELECT * FROM "WebhookEndpointHistory"`),
      );
      places.outbox = JSON.stringify(await t.rows(`SELECT * FROM "Outbox"`));
      const redis = t.app.get(RedisService).client;
      const cache: Record<string, unknown> = {};
      for (const key of await redis.keys('*wh:*')) {
        const type = await redis.type(key);
        cache[key] =
          type === 'string'
            ? await redis.get(key)
            : type === 'hash'
              ? await redis.hgetall(key)
              : type;
      }
      expect(Object.keys(cache).length).toBeGreaterThan(0); // the routing path did cache the shop's subscriptions
      places.cache = JSON.stringify(cache);
      const dynamo = t.app.get(DynamoService);
      const scan = await dynamo.doc.send(
        new ScanCommand({ TableName: dynamo.table('WebhookAttempts') }),
      );
      expect(scan.Items?.length).toBeGreaterThan(0);
      places.deliveryLog = JSON.stringify(scan.Items);
      places.logs = t.rawLogs();
      places.metrics = JSON.stringify(
        [
          'webhook_delivery_attempts_total',
          'webhook_delivery_duration_seconds',
          'webhook_routing_lag_seconds',
          'webhook_breaker_degraded_total',
          'webhook_auto_disabled_total',
          'webhook_dead_lettered_total',
        ].map((name) => MetricsRegistry.labelSets(name)),
      );
      for (const [place, content] of Object.entries(places))
        for (const secret of secrets)
          if (content.includes(secret))
            throw new Error(`a secret appears in ${place}`);
      expect(places.endpointRows).toContain('v2.'); // only the context-bound sealed value is at rest

      const sealed = (await stored(e.id)).secretSealed;
      expect(() => open(sealed, other.id)).toThrow();
      expect(() => t.app.get(SecretBox).open(sealed)).toThrow();
    });
  });
});
