import { v4 } from 'uuid';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { ApiConfigService, ConfigRules } from '@app/common/config';
import { CLOCK } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import { ScriptLoader } from '@app/infrastructure/rate-limit/script-loader';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { DeliveryWorkerService } from './application/delivery-worker.service';
import { DeviceService } from './application/device.service';
import { readNotificationsSettings } from './application/notifications-settings';
import { PreferencesService } from './application/preferences.service';
import { SuppressionService } from './application/suppression.service';
import { lineQueueOf } from './domain/lines';
import {
  DEAD_LETTER_SINK,
  DELIVERY_TIMELINE_STORE,
  PROVIDER_CHAINS,
  type DeadLetterSink,
  type DeliveryTimelineStore,
  type ProviderChains,
} from './domain/ports';
import type { DeliveryMessage } from './domain/types';
import { NOTIFICATION_PROVIDERS } from './infra/notification-providers';
import { notificationsRatePolicies } from './rate-limit-policies';
import {
  createNotificationsApp,
  faultSwitch,
  purgeDeliveryLines,
  queueDepth,
  TestClock,
  waitFor as waitForSoon,
  waitForQueueEmpty,
  type NotificationsTestApp,
  type TestUser,
} from './testing';

/** Line workers need a moment; a queue receive abandoned by an earlier run can hold a message for one visibility timeout. */
const waitFor: typeof waitForSoon = (probe, options = {}) =>
  waitForSoon(probe, { timeoutMs: 45_000, ...options });

type Channel = DeliveryMessage['channel'];

describe('Notifications: channel lines, providers, failover and retries', () => {
  let t: NotificationsTestApp;
  const port = <T>(token: symbol) => t.app.get<T>(token, { strict: false });
  const service = <T>(type: abstract new (...args: never[]) => T) =>
    t.app.get<T>(type, { strict: false });
  const worker = () => service(DeliveryWorkerService);
  const taskQueue = () => service(TaskQueue);
  const timeline = () => port<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE);
  const metric = (name: string, labels: Record<string, string> = {}) =>
    MetricsRegistry.value(name, labels) ?? 0;

  beforeAll(async () => {
    t = await createNotificationsApp({ env: { EMAIL_PROVIDER: 'memory' } });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await t.reset();
    await purgeDeliveryLines(t);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---- helpers -------------------------------------------------------------------------------------------------------

  /**
   * A rendered delivery with its timeline row. A message with no `userId` is addressed to a bare address (no preference
   * to re-check), which is how the line specs stage volume.
   */
  async function stage(
    channel: Channel,
    options: {
      user?: TestUser;
      to?: string[];
      type?: DeliveryMessage['type'];
      priority?: DeliveryMessage['priority'];
      staleAt?: string;
    } = {},
  ): Promise<DeliveryMessage> {
    const priority = options.priority ?? 'transactional';
    const id = v4();
    const message: DeliveryMessage = {
      deliveryId: id,
      userId: options.user?.id ?? '',
      type: options.type ?? 'order.shipped',
      channel,
      priority,
      to: options.to ?? [
        channel === 'email'
          ? (options.user?.email ?? `${id}@example.com`)
          : channel === 'sms'
            ? '+380501234567'
            : `tok-${id}`,
      ],
      subject: 'Subject',
      html: '<p>Hello</p>',
      title: 'Title',
      body: 'Body',
      link: '/orders/1',
      ...(options.staleAt && { staleAt: options.staleAt }),
    };
    await timeline().begin(
      {
        deliveryId: id,
        userId: message.userId || null,
        channel,
        type: message.type,
        line: priority,
      },
      t.clock.now(),
    );
    return message;
  }

  const queueOf = (m: DeliveryMessage) => lineQueueOf(m.priority, m.channel);
  /** What the queue consumer hands the worker for a message on its line. */
  const handle = (m: DeliveryMessage, attempt?: number) =>
    worker().process(queueOf(m), {
      id: `msg-${m.deliveryId}`,
      body: m,
      attributes: attempt ? { attempt: String(attempt) } : {},
    });
  const putOnLine = (m: DeliveryMessage) => taskQueue().enqueue(queueOf(m), m);

  type Captured = {
    queue: string;
    body: DeliveryMessage;
    options: { delaySeconds?: number; attributes?: Record<string, string> };
  };
  /**
   * Retries and put-backs the worker makes on `queues` (they carry an `attempt` attribute) are recorded instead of
   * being enqueued: a delay is real time and a spec cannot wait out 30 s of backoff. Everything else passes through.
   */
  function captureReturns(...queues: string[]): Captured[] {
    return capture(1, queues);
  }
  /** Only the real retries (attempt 2 and up): a message put back over budget goes on to the queue as usual. */
  function captureRetries(...queues: string[]): Captured[] {
    return capture(2, queues);
  }
  function capture(minAttempt: number, queues: string[]): Captured[] {
    const q = taskQueue();
    const original = q.enqueue.bind(q);
    const captured: Captured[] = [];
    jest.spyOn(q, 'enqueue').mockImplementation(((
      queue: string,
      body: DeliveryMessage,
      options?: Captured['options'],
    ) => {
      if (
        queues.includes(queue) &&
        Number(options?.attributes?.attempt) >= minAttempt
      ) {
        captured.push({ queue, body, options: options ?? {} });
        return Promise.resolve('captured');
      }
      return original(queue, body, options);
    }) as never);
    return captured;
  }

  const statusOf = async (id: string) => (await timeline().find(id))?.status;
  const rowsOf = async (id: string) =>
    (
      await t.app
        .get(CassandraService)
        .execute(
          'SELECT status, detail, provider, failover FROM delivery_timeline WHERE delivery_id = ?',
          [id],
        )
    ).rows.map((r) => ({
      status: r.get('status') as string,
      detail: (r.get('detail') as string | null) ?? null,
      provider: (r.get('provider') as string | null) ?? null,
      failover: (r.get('failover') as boolean | null) ?? null,
    }));
  const sentRow = async (id: string) =>
    (await rowsOf(id)).find((r) => r.status === 'sent');
  const sequelize = () =>
    t.app.get<Sequelize>(getConnectionToken(), { strict: false });
  const suppressionReason = async (channel: string, address: string) => {
    const rows = await sequelize().query<{ reason: string }>(
      'SELECT "reason" FROM "NotificationSuppression" WHERE "channel" = $1 AND "address" = $2',
      { bind: [channel, address], type: QueryTypes.SELECT },
    );
    return rows[0]?.reason ?? null;
  };
  const registerDevice = async (user: TestUser) => {
    const token = `tok-${v4()}`;
    const { device } = await service(DeviceService).register(user.id, {
      token,
      platform: 'ios',
    });
    return { token, deviceId: device.id };
  };

  // ---- lines ---------------------------------------------------------------------------------------------------------

  it('S28 AS-40: an SMS provider that fails every call does not delay e-mail or push; the SMS deliveries are retried', async () => {
    t.providers.sms.failAlways();
    const retries = captureRetries('notify-sms');
    const sms = await Promise.all(
      Array.from({ length: 50 }, () => stage('sms')),
    );
    const mail = await Promise.all(
      Array.from({ length: 20 }, () => stage('email')),
    );
    const push = await Promise.all(
      Array.from({ length: 20 }, () => stage('push')),
    );

    const startedAt = Date.now();
    for (const m of [...sms, ...mail, ...push]) await putOnLine(m);
    await waitFor(
      async () =>
        (
          await Promise.all(
            [...mail, ...push].map((m) => statusOf(m.deliveryId)),
          )
        ).every((status) => status === 'sent'),
      { description: 'all 40 e-mail and push deliveries sent' },
    );
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(t.providers.email.calls).toHaveLength(20);
    expect(t.providers.push.calls).toHaveLength(20);

    // the SMS backlog is retried through its own line (AS-47), none of it is sent
    await waitFor(async () => retries.length === 50, {
      description: 'every SMS delivery back on its line',
    });
    for (const r of retries) {
      expect(r.options.attributes?.attempt).toBe('2');
      expect(r.options.delaySeconds).toBeGreaterThanOrEqual(0);
      expect(r.options.delaySeconds).toBeLessThanOrEqual(30);
    }
    for (const m of sms) expect(await statusOf(m.deliveryId)).toBe('queued');
  });

  it('S28 AS-41: a transactional push never waits behind a marketing backlog of 500', async () => {
    t.providers.push.slow(150);
    const limiter = service(RateLimiterService);
    const check = jest.spyOn(limiter, 'check');
    const backlog = await Promise.all(
      Array.from({ length: 500 }, () =>
        stage('push', { priority: 'marketing' }),
      ),
    );
    await taskQueue().enqueueBatch(
      'notify-marketing-push',
      backlog.map((body) => ({ body })),
    );
    await waitFor(async () => t.providers.push.calls.length > 0, {
      description: 'the marketing line is draining',
    });

    const urgent = await stage('push');
    await putOnLine(urgent);
    await waitFor(async () => (await statusOf(urgent.deliveryId)) === 'sent', {
      description: 'the transactional push',
    });

    const marketingSent = t.providers.push.calls.filter(
      (m) => m.priority === 'marketing',
    ).length;
    expect(marketingSent).toBeLessThan(100);
    expect(t.providers.push.callsTo(urgent.to[0])).toHaveLength(1);
    // the two kinds of the same channel draw on different budgets
    const policies = new Set(check.mock.calls.map(([policy]) => policy));
    expect(policies).toEqual(new Set(['notify.push', 'notify.push.marketing']));
    t.providers.push.heal();
    await purgeDeliveryLines(t);
  });

  it('S28 AS-41: a failing marketing SMS line does not stop marketing push', async () => {
    t.providers.sms.failAlways();
    const retries = captureRetries('notify-marketing-sms');
    const sms = await Promise.all(
      Array.from({ length: 10 }, () => stage('sms', { priority: 'marketing' })),
    );
    const push = await Promise.all(
      Array.from({ length: 10 }, () =>
        stage('push', { priority: 'marketing' }),
      ),
    );
    for (const m of [...sms, ...push]) await putOnLine(m);

    await waitFor(
      async () =>
        (await Promise.all(push.map((m) => statusOf(m.deliveryId)))).every(
          (s) => s === 'sent',
        ),
      { description: 'marketing push drained' },
    );
    await waitFor(async () => retries.length === 10, {
      description: 'marketing SMS retried on its own line',
    });
  });

  // ---- send budgets --------------------------------------------------------------------------------------------------

  /** Takes every token of a send budget (one provider's bucket) and returns the denial. */
  const exhaust = async (
    policy: 'notify.email' | 'notify.email.marketing',
    subject: string,
  ) => {
    const limiter = service(RateLimiterService);
    for (let i = 0; i < 500; i++) {
      const decision = await limiter.check(policy, subject);
      if (!decision.allowed) return decision;
    }
    throw new Error(`${policy} was never exhausted`);
  };

  it('S28 AS-42: over the provider budget a delivery goes back with the limiter retry-after and no attempt is counted; it is sent when budget exists', async () => {
    const user = await t.newUser();
    const returned = captureReturns('notify-email');
    await exhaust('notify.email', t.providers.email.name);
    const m = await stage('email', { user });

    await handle(m);
    expect(t.providers.email.calls).toHaveLength(0);
    expect(returned).toHaveLength(1);
    expect(returned[0].options.attributes?.attempt).toBe('1'); // not a retry: the attempt is unchanged
    expect(returned[0].options.delaySeconds).toBeGreaterThanOrEqual(1);
    expect(returned[0].options.delaySeconds).toBeLessThanOrEqual(900);
    expect(await statusOf(m.deliveryId)).toBe('queued');

    await waitFor(
      async () => {
        await handle(m);
        return (await statusOf(m.deliveryId)) === 'sent';
      },
      { description: 'sent once the bucket refilled', intervalMs: 500 },
    );
    expect(t.providers.email.callsTo(user.email)).toHaveLength(1);
    for (const r of returned) expect(r.options.attributes?.attempt).toBe('1');
  });

  it('S28 AS-42: marketing draws on its own budget of about 20 % of the channel, and an exhausted marketing budget never delays a transactional send', async () => {
    const { policies } = notificationsRatePolicies;
    expect(
      policies['notify.email.marketing'].limit / policies['notify.email'].limit,
    ).toBeLessThanOrEqual(0.25);

    const returned = captureReturns('notify-marketing-email');
    await exhaust('notify.email.marketing', t.providers.email.name);
    const marketing = await stage('email', { priority: 'marketing' });
    await handle(marketing);
    expect(returned).toHaveLength(1);
    expect(returned[0].options.attributes?.attempt).toBe('1');
    expect(t.providers.email.calls).toHaveLength(0);

    const urgent = await stage('email', { user: await t.newUser() });
    await handle(urgent);
    expect(await statusOf(urgent.deliveryId)).toBe('sent');
    expect(t.providers.email.calls).toHaveLength(1);
  });

  it('S28 AS-43: with the limiter store down a transactional send goes ahead and a marketing one waits 60 s; both are counted', async () => {
    const limiter = service(RateLimiterService);
    // no local lease may answer for the store: the outage is what the worker must see
    await limiter.reset('notify.email', t.providers.email.name);
    const returned = captureReturns('notify-marketing-email');
    const tx = await stage('email', { user: await t.newUser() });
    const marketing = await stage('email', { priority: 'marketing' });
    const before = {
      transactional: metric('notifications_limiter_unavailable_total', {
        priority: 'transactional',
      }),
      marketing: metric('notifications_limiter_unavailable_total', {
        priority: 'marketing',
      }),
    };

    const outage = faultSwitch(service(ScriptLoader), ['run']);
    outage.down();
    try {
      await handle(tx);
      await handle(marketing);
    } finally {
      outage.restore();
    }

    expect(await statusOf(tx.deliveryId)).toBe('sent'); // fail-open
    expect(t.providers.email.callsTo(tx.to[0])).toHaveLength(1);
    expect(t.providers.email.callsTo(marketing.to[0])).toHaveLength(0); // fail-closed
    expect(returned).toHaveLength(1);
    expect(returned[0].options.delaySeconds).toBe(60);
    expect(returned[0].options.attributes?.attempt).toBe('1');
    expect(
      metric('notifications_limiter_unavailable_total', {
        priority: 'transactional',
      }),
    ).toBe(before.transactional + 1);
    expect(
      metric('notifications_limiter_unavailable_total', {
        priority: 'marketing',
      }),
    ).toBe(before.marketing + 1);
  });

  // ---- provider chain ------------------------------------------------------------------------------------------------

  it('S28 AS-44: a transient failure of the primary fails over in the same attempt; the timeline says so and exactly one mail leaves', async () => {
    const user = await t.newUser();
    const m = await stage('email', { user });
    t.providers.email.failNext(1);

    await handle(m);

    expect(t.providers.email.calls).toHaveLength(1);
    expect(t.providers.emailFallback.callsTo(user.email)).toHaveLength(1);
    expect(await statusOf(m.deliveryId)).toBe('sent');
    expect(await sentRow(m.deliveryId)).toMatchObject({
      provider: 'smtp',
      failover: true,
    });
  });

  it('S28 AS-45: after more than half of 10 calls fail the primary is skipped without a call; one probe goes through after 30 s and its result closes or reopens the breaker', async () => {
    const circuit = () =>
      metric('notifications_provider_circuit_state', { provider: 'ses' });
    t.providers.email.failAlways();
    const sendOne = async () => {
      const m = await stage('email', { user: await t.newUser() });
      await handle(m);
      return m;
    };

    for (let i = 0; i < 10; i++) await sendOne();
    expect(t.providers.email.calls).toHaveLength(10);
    expect(circuit()).toBe(2); // open

    const skipped = await sendOne();
    expect(t.providers.email.calls).toHaveLength(10); // zero calls to the primary
    expect(t.providers.emailFallback.callsTo(skipped.to[0])).toHaveLength(1);
    expect(await sentRow(skipped.deliveryId)).toMatchObject({
      provider: 'smtp',
      failover: true,
    });

    // reset time passes: exactly one probe; it fails, the breaker reopens
    t.clock.advance(31_000);
    await sendOne();
    await sendOne();
    expect(t.providers.email.calls).toHaveLength(11);
    expect(circuit()).toBe(2);

    // next reset time: the probe succeeds, the breaker closes and traffic returns to the primary
    t.clock.advance(31_000);
    t.providers.email.heal();
    const probe = await sendOne();
    expect(t.providers.email.calls).toHaveLength(12);
    expect(await sentRow(probe.deliveryId)).toMatchObject({ provider: 'ses' });
    expect(circuit()).toBe(0);
    await sendOne();
    expect(t.providers.email.calls).toHaveLength(13);
  });

  it('S28 AS-46: a permanent e-mail failure suppresses the address with no failover and no retry; the message is acknowledged', async () => {
    const user = await t.newUser();
    const returned = captureReturns('notify-email');
    const m = await stage('email', { user });
    t.providers.email.failPermanently();

    await handle(m);

    expect(t.providers.email.calls).toHaveLength(1);
    expect(t.providers.emailFallback.calls).toHaveLength(0);
    expect(returned).toHaveLength(0);
    expect(await statusOf(m.deliveryId)).toBe('failed');
    expect(await rowsOf(m.deliveryId)).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        detail: 'ses: permanent failure',
      }),
    );
    expect(await suppressionReason('email', user.email)).toBe(
      'provider-permanent',
    );
    expect(
      await service(SuppressionService).isSuppressed('email', user.email),
    ).toBe(true);
  });

  it('S28 AS-46: a permanent SMS failure suppresses the number; an unregistered push token removes the device', async () => {
    const phone = '+380509998877';
    const sms = await stage('sms', { to: [phone] });
    t.providers.sms.failPermanently();
    await handle(sms);
    expect(await statusOf(sms.deliveryId)).toBe('failed');
    expect(await suppressionReason('sms', phone)).toBe('provider-permanent');

    const user = await t.newUser();
    const { token } = await registerDevice(user);
    const push = await stage('push', { user, to: [token] });
    t.providers.push.failPermanently([token]);
    await handle(push);
    expect(await statusOf(push.deliveryId)).toBe('failed');
    expect(t.providers.push.calls).toHaveLength(1);
    expect((await service(DeviceService).list(user.id)).items).toHaveLength(0);
  });

  it('S28 AS-47: all providers failing transiently are retried through the line with backoff, 5 attempts, then dead-lettered as failed/exhausted', async () => {
    const user = await t.newUser();
    t.providers.email.failAlways();
    t.providers.emailFallback.failAlways();
    const returned = captureReturns('notify-email');
    const m = await stage('email', { user });
    const deadBefore = metric('notifications_dead_letter_total', {
      source: 'notify-email',
      reason: 'exhausted',
    });

    for (let attempt = 1; attempt <= 4; attempt++) {
      await handle(m, attempt);
      expect(returned).toHaveLength(attempt);
      const back = returned[attempt - 1];
      expect(back.options.attributes?.attempt).toBe(String(attempt + 1));
      expect(back.options.delaySeconds).toBeGreaterThanOrEqual(0);
      expect(back.options.delaySeconds).toBeLessThanOrEqual(
        Math.min(900, 30 * 2 ** (attempt - 1)),
      );
      expect(await statusOf(m.deliveryId)).toBe('queued');
    }
    expect(await queueDepth(t, 'notify-email-dlq')).toBe(0);

    await handle(m, 5);
    expect(returned).toHaveLength(4); // no sixth attempt
    await waitFor(async () => (await queueDepth(t, 'notify-email-dlq')) === 1, {
      description: 'the dead-letter line holds the message',
    });
    expect(await statusOf(m.deliveryId)).toBe('failed');
    expect(await rowsOf(m.deliveryId)).toContainEqual(
      expect.objectContaining({ status: 'failed', detail: 'exhausted' }),
    );
    expect(
      metric('notifications_dead_letter_total', {
        source: 'notify-email',
        reason: 'exhausted',
      }),
    ).toBe(deadBefore + 1);
    expect(t.providers.email.calls).toHaveLength(5);
    expect(t.providers.emailFallback.calls).toHaveLength(5);
  });

  // ---- idempotency and malformed messages ----------------------------------------------------------------------------

  it('S28 AS-49: the same queue message delivered again does not reach the provider and adds no timeline row', async () => {
    const user = await t.newUser();
    const m = await stage('email', { user });
    await putOnLine(m);
    await waitFor(async () => (await statusOf(m.deliveryId)) === 'sent', {
      description: 'first delivery sent',
    });
    const rows = (await rowsOf(m.deliveryId)).length;

    await putOnLine(m); // the visibility timeout expired somewhere and the queue hands the message over again
    await putOnLine(m);
    await waitForQueueEmpty(t, 'notify-email');

    expect(t.providers.email.callsTo(user.email)).toHaveLength(1);
    expect(await rowsOf(m.deliveryId)).toHaveLength(rows);
  });

  it('S28 AS-49: two concurrent copies of 20 messages produce one provider call each', async () => {
    t.providers.email.slow(60);
    const users = await Promise.all(
      Array.from({ length: 20 }, () => t.newUser()),
    );
    const messages = await Promise.all(
      users.map((user) => stage('email', { user })),
    );

    await Promise.all(messages.flatMap((m) => [handle(m), handle(m)]));

    for (const m of messages) {
      expect(t.providers.email.callsTo(m.to[0])).toHaveLength(1);
      expect(await statusOf(m.deliveryId)).toBe('sent');
      expect(
        (await rowsOf(m.deliveryId)).filter((r) => r.status === 'sent'),
      ).toHaveLength(1);
    }
  });

  it('S28 AS-50: a malformed message is dead-lettered as invalid_message without its body; no provider is called and the line keeps flowing', async () => {
    const user = await t.newUser();
    const valid = await stage('email', { user });
    const withoutId: Partial<DeliveryMessage> = { ...valid };
    delete withoutId.deliveryId;
    const before = metric('notifications_dead_letter_total', {
      source: 'notify-email',
      reason: 'invalid_message',
    });
    await taskQueue().enqueue('notify-email', withoutId);
    await taskQueue().enqueue('notify-email', {
      ...valid,
      deliveryId: v4(),
      channel: 'fax',
    });
    await putOnLine(valid);

    await waitFor(async () => (await statusOf(valid.deliveryId)) === 'sent', {
      description: 'the valid message behind the bad ones',
    });
    await waitFor(async () => (await queueDepth(t, 'notify-email-dlq')) === 2, {
      description: 'both malformed messages dead-lettered',
    });
    expect(t.providers.email.calls).toHaveLength(1);
    expect(t.providers.emailFallback.calls).toHaveLength(0);

    const records = (
      await port<DeadLetterSink>(DEAD_LETTER_SINK).recent(10)
    ).filter((r) => r.reason === 'invalid_message');
    expect(records).toHaveLength(2);
    for (const r of records) expect(r.source).toBe('notify-email');
    const text = JSON.stringify(records);
    expect(text).not.toContain(user.email);
    expect(text).not.toContain('Subject');
    expect(
      metric('notifications_dead_letter_total', {
        source: 'notify-email',
        reason: 'invalid_message',
      }),
    ).toBe(before + 2);
  });

  // ---- send-time checks ----------------------------------------------------------------------------------------------

  it('S28 AS-51: an address suppressed after the delivery was queued is not sent to; a push whose only token was removed shows no_device', async () => {
    const user = await t.newUser();
    const mail = await stage('email', { user });
    await service(SuppressionService).suppress('email', [user.email], 'manual');
    await handle(mail);
    expect(t.providers.email.calls).toHaveLength(0);
    expect(await statusOf(mail.deliveryId)).toBe('suppressed');

    const owner = await t.newUser();
    const { token, deviceId } = await registerDevice(owner);
    const push = await stage('push', { user: owner, to: [token] });
    await service(DeviceService).remove(owner.id, deviceId);
    await handle(push);
    expect(t.providers.push.calls).toHaveLength(0);
    expect(await statusOf(push.deliveryId)).toBe('suppressed');
    expect(await rowsOf(push.deliveryId)).toContainEqual(
      expect.objectContaining({ status: 'suppressed', detail: 'no_device' }),
    );
  });

  it('S28 AS-52: a preference switched off after the delivery was queued skips it; a mandatory type ignores the check', async () => {
    const user = await t.newUser();
    const { token } = await registerDevice(user);
    const push = await stage('push', { user, to: [token] });
    await service(PreferencesService).setCell(user.id, 'orders', 'push', false);
    await handle(push);
    expect(t.providers.push.calls).toHaveLength(0);
    expect(await statusOf(push.deliveryId)).toBe('skipped');
    expect(await rowsOf(push.deliveryId)).toContainEqual(
      expect.objectContaining({ status: 'skipped', detail: 'preference' }),
    );

    const notice = await stage('email', {
      user,
      type: 'billing.payment_failed',
    });
    await service(PreferencesService).setCell(
      user.id,
      'billing',
      'email',
      false,
    );
    await handle(notice);
    expect(await statusOf(notice.deliveryId)).toBe('sent');
    expect(t.providers.email.callsTo(user.email)).toHaveLength(1);
  });

  it('S28 AS-34: a delivery that went stale while it waited on its line is expired at send time', async () => {
    const user = await t.newUser();
    const m = await stage('email', {
      user,
      staleAt: new Date(t.clock.now().getTime() - 1_000).toISOString(),
    });
    await handle(m);
    expect(t.providers.email.calls).toHaveLength(0);
    expect(await statusOf(m.deliveryId)).toBe('expired');
  });

  it('S28 AS-53: a provider that does not answer within 10 s is abandoned and the fallback is tried in the same attempt', async () => {
    const user = await t.newUser();
    const m = await stage('email', { user });
    t.providers.email.hang();

    const startedAt = Date.now();
    await handle(m);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(9_900);
    expect(elapsed).toBeLessThan(25_000);
    expect(t.providers.email.calls).toHaveLength(1);
    expect(t.providers.emailFallback.callsTo(user.email)).toHaveLength(1);
    expect(await sentRow(m.deliveryId)).toMatchObject({
      provider: 'smtp',
      failover: true,
    });
    t.providers.email.heal();
  }, 40_000);

  // ---- production configuration --------------------------------------------------------------------------------------

  describe('production configuration and stand-ins', () => {
    const SECRET = 's'.repeat(40);
    const CREDENTIALS = {
      ses_from_address: 'Shop <no-reply@shop.example>',
      twilio_account_sid: 'AC1',
      twilio_auth_token: 'token',
      twilio_from: '+15005550006',
      firebase_client_email: 'svc@project.iam.gserviceaccount.com',
      firebase_private_key:
        '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
    };
    const boot = async (values: Record<string, unknown>) => {
      const config = { get: (key: string) => values[key] };
      return Test.createTestingModule({
        providers: [
          { provide: ApiConfigService, useValue: config },
          { provide: CLOCK, useValue: new TestClock() },
          ...NOTIFICATION_PROVIDERS,
        ],
      }).compile();
    };

    it.each([
      ['ses_from_address', /ses_from_address, smtp_url/],
      [
        'twilio_auth_token',
        /twilio_account_sid, twilio_auth_token, twilio_from/,
      ],
      ['firebase_private_key', /firebase_client_email, firebase_private_key/],
    ])(
      'S28 AS-54: production without %s fails startup naming the setting',
      async (missing, message) => {
        const values: Record<string, unknown> = {
          node_env: 'production',
          ...CREDENTIALS,
        };
        delete values[missing];
        await expect(boot(values)).rejects.toThrow(message);
      },
    );

    it('S28 AS-54: production without the memory mailbox, with every credential, starts; the memory mailbox is refused', async () => {
      await expect(
        boot({
          node_env: 'production',
          ...CREDENTIALS,
          email_provider: 'memory',
        }),
      ).rejects.toThrow(/e-mail provider/);
    });

    it('S28 AS-54: production without notification_secret fails startup, and so does any environment that reads the settings', () => {
      expect(() =>
        ConfigRules.assertValid(
          { node_env: 'production', jwt_secret: SECRET, ...CREDENTIALS },
          { production: true },
        ),
      ).toThrow(/notification_secret is required/);
      expect(() =>
        readNotificationsSettings({
          get: () => undefined,
        } as unknown as ApiConfigService),
      ).toThrow(/notification_secret/);
    });

    it('S28 AS-54: outside production the stand-ins start, are reported in the startup log, and a message they handle is recorded as provider "log", never delivered', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const moduleRef = await boot({
        node_env: 'test',
        email_provider: 'memory',
      });
      const logged = warn.mock.calls.map(([line]) => String(line));
      for (const channel of ['email', 'sms', 'push'])
        expect(logged).toContainEqual(
          expect.stringContaining(`stand_in channel=${channel}`),
        );

      const standIns = moduleRef.get<ProviderChains>(PROVIDER_CHAINS);
      warn.mockRestore();
      const sms = await stage('sms');
      jest
        .spyOn(port<ProviderChains>(PROVIDER_CHAINS).sms, 'send')
        .mockImplementation((message) => standIns.sms.send(message));
      await handle(sms);

      const summary = await timeline().find(sms.deliveryId);
      expect(summary?.provider).toBe('log');
      expect(summary?.status).toBe('sent');
      expect((await rowsOf(sms.deliveryId)).map((r) => r.status)).not.toContain(
        'delivered',
      );
      expect(t.providers.sms.calls).toHaveLength(0);
    });
  });
});
