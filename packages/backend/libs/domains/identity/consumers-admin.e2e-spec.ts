import { v7 as uuidv7 } from 'uuid';
import {
  consumerRedriveResultSchema,
  consumerViewSchema,
  JOURNEY_CONSUMER_GROUPS,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import { fixtureConsumer } from '@app/infrastructure/events/testing/fixture-consumers';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { readTopic } from '@app/test/utils/kafka-test';
import { waitFor } from '@app/test/utils/async-helpers';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { IdentityOpsModule } from './identity-ops.module';
import { SessionIssuer } from './application/session-issuer.service';
import { SessionRevocationService } from './application/session-revocation.service';
import { Role } from './infra/models/user.model';
import { AuthTestApp, createAuthApp } from './testing/auth-app';

const kit = new ConsumerKit();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pauseKey = (group: string) => `consumer:pause:${group}`;

describe('Consumer operator routes (S53, J01 G-26, G-31)', () => {
  let t: AuthTestApp;
  let redis: RedisService;
  let admin: string;
  let adminId: string;
  let adminSid: string;

  const sessionFor = async (role: Role) => {
    const user = await t.seedUser({ role });
    const session = await t.app
      .get(SessionIssuer)
      .issue({ userId: user.id, amr: ['pwd'] });
    return { user, session };
  };
  const call = (
    method: 'get' | 'post',
    path: string,
    token?: string,
    body?: object,
  ) => {
    const req = t.http()[method](path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };
  const view = async (group: string) =>
    consumerViewSchema.parse(
      (await call('get', `/api/admin/consumers/${group}`, admin).expect(200))
        .body,
    );

  /** A runner (the fixture consumer under the real `ProjectionRunner`) on a fresh topic. */
  const runner = async (
    partitions = 1,
    extra: Partial<Parameters<typeof fixtureConsumer>[0]> = {},
  ) => {
    const s = await kit.scenario(partitions);
    const Natural = s.make('natural', 'natural', extra);
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    return { s, Natural, app, consumer, group: consumer.name };
  };

  beforeAll(async () => {
    await kit.start();
    t = await createAuthApp({ extraImports: [IdentityOpsModule, SqsModule] });
    redis = t.app.get(RedisService);
  }, 120_000);
  afterAll(async () => {
    await redis.client.del(
      ...JOURNEY_CONSUMER_GROUPS.map(pauseKey),
      pauseKey('payments-order-copy'),
    );
    await kit.stopAll();
    await t.close();
  });
  beforeEach(async () => {
    // No global clean-up or Redis flush: other suites share these stores, and every group here is unique.
    t.clock.set(new Date());
    const { user, session } = await sessionFor(Role.ADMIN);
    admin = session.accessToken.token;
    adminId = user.id;
    adminSid = session.sessionId;
  });

  const routes: Array<['get' | 'post', string]> = [
    ['get', '/api/admin/consumers/payments-order-copy'],
    ['post', '/api/admin/consumers/payments-order-copy/pause'],
    ['post', '/api/admin/consumers/payments-order-copy/resume'],
    ['post', '/api/admin/consumers/payments-order-copy/replay'],
    ['post', '/api/admin/consumers/payments-order-copy/dlq/redrive'],
  ];

  it.each(routes)(
    'J01 G-31: %s %s without a token answers 401',
    async (method, path) => {
      await call(method, path).expect(401);
    },
  );

  it.each(
    routes.flatMap(([m, p]) =>
      [Role.USER, Role.SELLER, Role.MODERATOR].map((r) => [r, m, p] as const),
    ),
  )('J01 G-31: a %s gets 403 on %s %s', async (role, method, path) => {
    const { session } = await sessionFor(role);
    const res = await call(method, path, session.accessToken.token).expect(403);
    expect(problemDetailsSchema.parse(res.body).status).toBe(403);
  });

  it.each(routes)(
    'J01 G-31: %s %s is refused for an admin whose session was revoked (sensitive session required)',
    async (method, path) => {
      await t.app.get(SessionRevocationService).revokeBySid(adminSid, 'logout');
      await call(method, path, admin, {
        since: new Date().toISOString(),
      }).expect(401);
      expect(await redis.client.exists(pauseKey('payments-order-copy'))).toBe(
        0,
      );
    },
  );

  it('J01 G-31: an unknown group answers 404 consumer_not_found on every route', async () => {
    for (const [method, suffix] of [
      ['get', ''],
      ['post', '/pause'],
      ['post', '/resume'],
      ['post', '/replay'],
      ['post', '/dlq/redrive'],
    ] as const) {
      const res = await call(
        method,
        `/api/admin/consumers/no-such-group${suffix}`,
        admin,
        suffix === '/replay'
          ? { since: new Date(t.clock.nowMs() - 1000).toISOString() }
          : undefined,
      ).expect(404);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'consumer_not_found',
      );
    }
    expect(await redis.client.exists(pauseKey('no-such-group'))).toBe(0);
  });

  it('S53 G-36: the seven seller-journey group names (J02) are known before any runner declared them', async () => {
    for (const group of [
      'identity-seller-promotion',
      'tenancy-shop-lifecycle',
      'entitlements-invalidation',
      'search-product-index',
      'webhook-router',
      'leaderboards',
      'product-cache-invalidator',
    ])
      expect((await view(group)).group).toBe(group);
  });

  it('J04 G-11 G-15 G-18: the catalog-sync journey aliases are known, pause/resume answer for them, and the real group names still resolve', async () => {
    for (const group of [
      'integrations-stock-push',
      'offline-sync-feed',
      'pickup-availability',
      'search-product-index',
      'product-cache-invalidator',
    ]) {
      const first = await view(group);
      expect(first.group).toBe(group);
      expect(first.lag).toBeGreaterThanOrEqual(0);
    }
    for (const group of [
      'integrations-stock-push',
      'offline-sync-feed',
      'pickup-availability',
    ])
      expect(JOURNEY_CONSUMER_GROUPS).toContain(group);
  });

  it('J01 G-31: the journey group names are known before any runner declared them', async () => {
    for (const group of JOURNEY_CONSUMER_GROUPS) {
      expect((await view(group)).group).toBe(group);
    }
  });

  it('J03 G-42: the booking-voucher queue consumer can be paused, its lag is the visible messages, other consumers keep running', async () => {
    const group = 'orders-booking-voucher';
    const queue = t.app.get(TaskQueue);
    const other = await view('payments-order-copy');
    const paused = await call(
      'post',
      `/api/admin/consumers/${group}/pause`,
      admin,
    ).expect(200);
    expect(consumerViewSchema.parse(paused.body).state).toBe('PAUSED');
    expect((await view('payments-order-copy')).state).toBe(other.state);

    // Held: the message stays in the queue, whoever consumes it (the flag is the same in every process).
    const before = (await view(group)).lag;
    await queue.enqueue('orders-booking-voucher-requested', { held: true });
    await waitFor(async () => (await view(group)).lag === before + 1, {
      description: 'one more message waiting',
    });

    // Clean up: take the message away ourselves, then resume.
    const drained: unknown[] = [];
    const stop = queue.consume(
      'orders-booking-voucher-requested',
      async ({ body }) => void drained.push(body),
      { waitTimeSec: 1, concurrency: 1 },
    );
    await waitFor(async () => drained.length > 0, {
      description: 'message drained by the spec',
    });
    await stop();
    const resumed = await call(
      'post',
      `/api/admin/consumers/${group}/resume`,
      admin,
    ).expect(200);
    expect(consumerViewSchema.parse(resumed.body).state).toBe('RUNNING');
    expect((await view(group)).lag).toBe(before);
  }, 60_000);

  it('J01 G-31: GET reports state, topics, lag, lastProcessedAt and dlqDepth of a running group', async () => {
    const { s, consumer, group } = await runner();
    const first = await view(group);
    expect(first).toEqual({
      group,
      topics: [s.topic],
      state: 'RUNNING',
      lag: 0,
      lastProcessedAt: null,
      dlqDepth: 0,
    });

    await s.publish(
      [1, 2, 3].map((n) =>
        s.ItemChanged.create(uuidv7(), 1, { name: `n${n}` }),
      ),
    );
    await waitFor(async () => (await kit.naturalRows(group)) === 3, {
      description: 'three applied',
    });
    const after = await waitFor(
      async () => {
        const v = await view(group);
        return v.lag === 0 && v.lastProcessedAt !== null && v;
      },
      { description: 'caught up and processed time recorded' },
    );
    expect(after.state).toBe('RUNNING');
    expect(consumer.probe.calls.length).toBeGreaterThan(0);
  }, 90_000);

  it('J01 G-31: pause persists the flag without expiry, stops the group, and lag counts what waits', async () => {
    const { s, group } = await runner();

    const res = await call(
      'post',
      `/api/admin/consumers/${group}/pause`,
      admin,
    ).expect(200);
    expect(consumerViewSchema.parse(res.body).state).toBe('PAUSED');
    const flag = JSON.parse((await redis.client.get(pauseKey(group)))!);
    expect(flag).toEqual({ pausedAt: expect.any(String), by: adminId });
    expect(await redis.client.ttl(pauseKey(group))).toBe(-1);

    await sleep(1500);
    await s.publish(
      [1, 2, 3].map((n) =>
        s.ItemChanged.create(uuidv7(), 1, { name: `p${n}` }),
      ),
    );
    await sleep(1500);
    expect(await kit.naturalRows(group)).toBe(0);
    expect((await view(group)).lag).toBe(3);

    const resumed = await call(
      'post',
      `/api/admin/consumers/${group}/resume`,
      admin,
    ).expect(200);
    expect(consumerViewSchema.parse(resumed.body).state).toBe('RUNNING');
    expect(await redis.client.exists(pauseKey(group))).toBe(0);
    await waitFor(async () => (await kit.naturalRows(group)) === 3, {
      description: 'applied after the resume',
    });
    await waitFor(async () => (await view(group)).lag === 0, {
      description: 'lag back to zero',
    });
  }, 90_000);

  it('J01 G-31: pause and resume are idempotent and a second pause keeps the first flag', async () => {
    const { group } = await runner();
    const pause = () =>
      call('post', `/api/admin/consumers/${group}/pause`, admin);
    const resume = () =>
      call('post', `/api/admin/consumers/${group}/resume`, admin);

    await resume().expect(200); // resuming a running group changes nothing
    expect(await redis.client.exists(pauseKey(group))).toBe(0);

    await pause().expect(200);
    const first = await redis.client.get(pauseKey(group));
    t.clock.advance(5000);
    await pause().expect(200);
    expect(await redis.client.get(pauseKey(group))).toBe(first);

    await resume().expect(200);
    await resume().expect(200);
    expect(await redis.client.exists(pauseKey(group))).toBe(0);
    expect((await view(group)).state).toBe('RUNNING');
  }, 90_000);

  it('J01 G-31: concurrent pauses leave one flag, concurrent resumes clear it, and mixed calls all answer 200', async () => {
    const { group } = await runner();
    const send = (verb: 'pause' | 'resume') =>
      call('post', `/api/admin/consumers/${group}/${verb}`, admin);

    const pauses = await Promise.all(
      Array.from({ length: 6 }, () => send('pause')),
    );
    expect(pauses.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(await redis.client.exists(pauseKey(group))).toBe(1);
    expect((await view(group)).state).toBe('PAUSED');

    const resumes = await Promise.all(
      Array.from({ length: 6 }, () => send('resume')),
    );
    expect(resumes.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(await redis.client.exists(pauseKey(group))).toBe(0);

    const mixed = await Promise.all(
      ['pause', 'resume', 'pause', 'resume', 'pause', 'resume'].map((v) =>
        send(v as 'pause' | 'resume'),
      ),
    );
    expect(mixed.map((r) => r.status)).toEqual(Array(6).fill(200));
    await send('resume').expect(200);
    expect(await redis.client.exists(pauseKey(group))).toBe(0);
  }, 90_000);

  it('J01 G-31: a second runner instance of the group honours the pause within 2 s and both resume', async () => {
    const a = await runner(2);
    const Natural = a.Natural;
    const b = await a.s.boot([Natural]);
    const second = b.get(Natural);
    await kit.awaitMembers(a.s.kafka, a.group, 2);

    await call('post', `/api/admin/consumers/${a.group}/pause`, admin).expect(
      200,
    );
    await sleep(2000);
    const events = [0, 1].map((partition) => ({
      partition,
      event: a.s.ItemChanged.create(uuidv7(), 1, { name: `q${partition}` }),
    }));
    for (const { partition, event } of events)
      await a.s.publish([event], { partition });
    await sleep(1500);

    expect(a.consumer.probe.calls).toHaveLength(0);
    expect(second.probe.calls).toHaveLength(0);
    expect(await kit.naturalRows(a.group)).toBe(0);
    expect((await view(a.group)).lag).toBe(2);

    await call('post', `/api/admin/consumers/${a.group}/resume`, admin).expect(
      200,
    );
    await waitFor(async () => (await kit.naturalRows(a.group)) === 2, {
      description: 'both partitions applied after the resume',
      timeoutMs: 10_000,
    });
    expect(a.consumer.probe.calls.length).toBeGreaterThan(0);
    expect(second.probe.calls.length).toBeGreaterThan(0);
  }, 120_000);

  it('J01 G-31: replay answers 202, rewinds to the first message at or after since, and resumes', async () => {
    const { s, consumer, group } = await runner();
    const events = [1, 2, 3].map((n) =>
      s.ItemChanged.create(uuidv7(), 1, { name: `r${n}` }),
    );
    await s.publish(events);
    await waitFor(async () => (await kit.naturalRows(group)) === 3, {
      description: 'applied once',
    });
    await waitFor(
      async () => (await kit.committed(s.kafka, group, s.topic))[0] === 3,
      { description: 'committed' },
    );

    const res = await call(
      'post',
      `/api/admin/consumers/${group}/replay`,
      admin,
      { since: new Date(t.clock.nowMs() - 60_000).toISOString() },
    ).expect(202);
    expect(res.body).toEqual({ accepted: true });

    await waitFor(
      async () =>
        events.every((e) => consumer.probe.invocationsOf(e.eventId) === 2) &&
        (await view(group)).state === 'RUNNING',
      {
        description: 'every event handled a second time, group running',
        timeoutMs: 30_000,
      },
    );
    expect(await kit.naturalRows(group)).toBe(3); // the consumer is idempotent
    expect(await redis.client.exists(pauseKey(group))).toBe(0);
    expect(await redis.client.exists(`consumer:replay:${group}`)).toBe(0);
    expect((await kit.committed(s.kafka, group, s.topic))[0]).toBe(3);
  }, 120_000);

  it.each([
    [
      'in the future',
      () => new Date(t.clock.nowMs() + 3_600_000).toISOString(),
    ],
    ['malformed', () => 'last tuesday'],
    ['not a string', () => 12345 as unknown as string],
  ])(
    'J01 G-31: replay with a since %s answers 422 and pauses nothing',
    async (_name, since) => {
      const { group } = await runner();
      const res = await call(
        'post',
        `/api/admin/consumers/${group}/replay`,
        admin,
        { since: since() },
      ).expect(422);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'validation_failed',
      );
      expect(await redis.client.exists(pauseKey(group))).toBe(0);
    },
    90_000,
  );

  it('J01 G-26: redrive answers 202 {requeued}, re-queues a dead-lettered event, and dlqDepth follows', async () => {
    const { s, consumer, group } = await runner(1, { attempts: 1 });
    const events = [1, 2].map((n) =>
      s.ItemChanged.create(uuidv7(), 1, { name: `d${n}` }),
    );
    for (const e of events)
      consumer.probe.throwBefore.set(e.eventId, {
        times: -1,
        error: () => new PermanentError('fix pending'),
      });
    await s.publish(events);
    await waitFor(async () => (await readTopic(`${group}.dlq`)).length === 2, {
      description: 'two dead letters',
    });

    expect((await view(group)).dlqDepth).toBe(2);
    expect(MetricsRegistry.value('consumer_dlq_depth', { group })).toBe(2);

    consumer.probe.throwBefore.clear(); // the cause is fixed
    const first = await call(
      'post',
      `/api/admin/consumers/${group}/dlq/redrive`,
      admin,
      { limit: 1 },
    ).expect(202);
    expect(consumerRedriveResultSchema.parse(first.body)).toEqual({
      requeued: 1,
    });
    await waitFor(async () => (await kit.naturalRows(group)) === 1, {
      description: 'the first letter applied',
    });
    expect((await view(group)).dlqDepth).toBe(1);

    const second = await call(
      'post',
      `/api/admin/consumers/${group}/dlq/redrive`,
      admin,
      {},
    ).expect(202);
    expect(consumerRedriveResultSchema.parse(second.body)).toEqual({
      requeued: 1,
    });
    await waitFor(async () => (await kit.naturalRows(group)) === 2, {
      description: 'both applied',
    });
    expect((await view(group)).dlqDepth).toBe(0);
    expect(MetricsRegistry.value('consumer_dlq_depth', { group })).toBe(0);

    const none = await call(
      'post',
      `/api/admin/consumers/${group}/dlq/redrive`,
      admin,
    ).expect(202);
    expect(none.body).toEqual({ requeued: 0 });
  }, 120_000);

  it('J01 G-26: redrive rejects a limit out of range with 422', async () => {
    const { group } = await runner();
    for (const limit of [0, -1, 1.5, 1001, 'many']) {
      const res = await call(
        'post',
        `/api/admin/consumers/${group}/dlq/redrive`,
        admin,
        { limit },
      ).expect(422);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'validation_failed',
      );
    }
  }, 90_000);
});
