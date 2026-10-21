import { v4 } from 'uuid';
import { getConnectionToken } from '@nestjs/sequelize';
import type { Sequelize } from 'sequelize';
import { JobsTestProbe } from '@app/infrastructure/jobs';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import {
  CAP_STORE,
  DELIVERY_LINE_PRODUCER,
  DELIVERY_TIMELINE_STORE,
  DEVICE_REPOSITORY,
  FOLLOWER_AUDIENCE,
  INBOX_STORE,
  PREFERENCE_REPOSITORY,
  SETTINGS_REPOSITORY,
  type CapStore,
  type DeliveryLineProducer,
  type DeliveryTimelineStore,
  type DeviceRepository,
  type FollowerAudience,
  type InboxStore,
  type PreferenceRepository,
  type SettingsRepository,
} from './domain/ports';
import { deliveryIdFor, identityOf } from './domain/ids';
import { redisKeys } from './infra/redis-stores';
import { SettingsService } from './application/settings.service';
import { WakeDeliveryService } from './application/wake-delivery.service';
import {
  consume,
  createNotificationsApp,
  envelope,
  faultSwitch,
  orderPaidEnvelope,
  waitFor as waitForSoon,
  waitForQueueEmpty,
  type NotificationsTestApp,
  type TestUser,
} from './testing';
import type { DeliveryMessage } from './domain/types';

/** Line workers need a moment; a queue receive abandoned by an earlier run can hold a message for one visibility timeout. */
const waitFor: typeof waitForSoon = (probe, options = {}) =>
  waitForSoon(probe, { timeoutMs: 45_000, intervalMs: 30, ...options });

const PHONE = '+380501234567';
const WAKE_JOB = 'notifications.wake-delivery';

describe('Notifications: quiet hours, expiry and frequency caps', () => {
  let t: NotificationsTestApp;
  let probe: JobsTestProbe;
  const audience = new Map<string, string[]>();
  const port = <T>(token: symbol) => t.app.get<T>(token, { strict: false });

  beforeAll(async () => {
    const followers: FollowerAudience = {
      followers: (accountId) =>
        Promise.resolve({
          userIds: audience.get(accountId) ?? [],
          nextCursor: null,
        }),
    };
    t = await createNotificationsApp({
      env: { EMAIL_PROVIDER: 'memory' },
      overrides: [{ provide: FOLLOWER_AUDIENCE, useValue: followers }],
    });
    probe = new JobsTestProbe(
      t.app.get<Sequelize>(getConnectionToken(), { strict: false }),
    );
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    audience.clear();
    await t.reset();
  });

  // ---- helpers -------------------------------------------------------------------------------------------------------

  /** Frozen clock at `iso`; every envelope is stamped with it. */
  const freezeAt = (iso: string) => {
    t.clock.set(new Date(iso));
    t.clock.freeze();
  };
  const setAt = (iso: string) => t.clock.set(new Date(iso));
  const stamp = () => ({ occurredAt: t.clock.now() });

  const settings = (
    user: TestUser,
    patch: Parameters<SettingsRepository['update']>[1],
  ) =>
    port<SettingsRepository>(SETTINGS_REPOSITORY).update(
      user.id,
      patch,
      t.clock.now(),
    );
  const kyivQuiet = (user: TestUser) =>
    settings(user, {
      timezone: 'Europe/Kyiv',
      quietStart: '22:00',
      quietEnd: '07:30',
    });
  const addDevice = async (user: TestUser) => {
    const token = `tok-${v4()}`;
    await port<DeviceRepository>(DEVICE_REPOSITORY).register(
      { userId: user.id, token, platform: 'ios' },
      10,
      t.clock.now(),
    );
    return token;
  };
  const optIn = (
    user: TestUser,
    category: string,
    channel: 'push' | 'email' | 'sms',
  ) =>
    port<PreferenceRepository>(PREFERENCE_REPOSITORY).set(
      user.id,
      category,
      channel,
      true,
      t.clock.now(),
    );
  const verifiedPhone = async (user: TestUser) => {
    const repo = port<SettingsRepository>(SETTINGS_REPOSITORY);
    await repo.update(user.id, { phone: PHONE }, t.clock.now());
    await repo.markPhoneVerified(user.id, PHONE, t.clock.now());
  };

  const deliveryId = (eventId: string, user: TestUser, channel: string) =>
    deliveryIdFor(
      identityOf(eventId, { kind: 'user', userId: user.id }),
      channel,
    );
  const timeline = () => port<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE);
  const statusOf = async (id: string) => (await timeline().find(id))?.status;
  const timelineRows = async (id: string) =>
    (
      await t.app
        .get(CassandraService)
        .execute(
          'SELECT status, detail FROM delivery_timeline WHERE delivery_id = ?',
          [id],
        )
    ).rows.map((r) => ({
      status: r.get('status') as string,
      detail: (r.get('detail') as string | null) ?? null,
    }));
  /** The inbox read from its store: the access token of a user is not valid at the frozen instants of these specs. */
  const inboxOf = (user: TestUser) =>
    port<InboxStore>(INBOX_STORE).page(user.id, 50, null, {
      from: new Date('2020-01-01T00:00:00Z'),
      to: new Date('2030-01-01T00:00:00Z'),
    });
  const wakeJobs = (id: string) => probe.find(WAKE_JOB, { deliveryId: id });
  const allWakeJobs = async () => (await probe.find(WAKE_JOB)).length;

  type LineCall = {
    channel: string;
    message: DeliveryMessage;
    options: { delaySeconds?: number; dedupeId: string };
  };
  /**
   * The push and SMS lines of the queue stand-in cannot be waited out in a spec (a delay is real time), so the producer
   * is held for those channels: what the router handed over is recorded, and `release` hands it to the real queue once
   * the spec has moved its clock past the wake instant. E-mail goes through at once.
   */
  function holdExternalLines() {
    const producer = port<DeliveryLineProducer>(DELIVERY_LINE_PRODUCER);
    const original = producer.enqueue.bind(producer);
    const held: LineCall[] = [];
    const spy = jest
      .spyOn(producer, 'enqueue')
      .mockImplementation((line, channel, message, options) => {
        if (channel === 'email')
          return original(line, channel, message, options);
        held.push({ channel, message, options });
        return Promise.resolve();
      });
    return {
      held,
      forChannel: (channel: string) =>
        held.filter((c) => c.channel === channel),
      release: async () => {
        for (const c of held.splice(0))
          await original(c.message.priority, c.channel as 'push', c.message, {
            dedupeId: c.options.dedupeId,
          });
      },
      stop: () => spy.mockRestore(),
    };
  }
  let line: ReturnType<typeof holdExternalLines> | null = null;
  afterEach(() => {
    line?.stop();
    line = null;
  });

  const feedEvent = (authorId: string, at: Date = t.clock.now()) =>
    envelope(
      'feed.item_published',
      {
        itemId: v4(),
        authorId,
        kind: 'drop_announced',
        createdAt: at.toISOString(),
      },
      { occurredAt: at },
    );
  const marketingUser = async (author: string, channels = ['push']) => {
    const user = await t.newUser();
    audience.set(author, [user.id]);
    for (const channel of channels)
      await optIn(user, 'marketing', channel as 'push');
    return user;
  };
  const capped = (user: TestUser, ev: { eventId: string }, channel = 'push') =>
    statusOf(deliveryId(ev.eventId, user, channel));

  // ---- quiet hours -----------------------------------------------------------------------------------------------------

  it('S28 AS-30: a quiet window ending in 10 minutes holds the push on its line for 600 s; the inbox item is immediate', async () => {
    const user = await t.newUser();
    await kyivQuiet(user);
    const token = await addDevice(user);
    freezeAt('2026-10-13T04:20:00Z'); // 07:20 in Kyiv, the window ends 07:30
    line = holdExternalLines();

    const event = orderPaidEnvelope({ userId: user.id }, stamp());
    await consume(t, [event]);

    expect(await inboxOf(user)).toHaveLength(1);
    const [push] = line.forChannel('push');
    expect(push.options.delaySeconds).toBeGreaterThanOrEqual(599);
    expect(push.options.delaySeconds).toBeLessThanOrEqual(601);
    expect(push.message.to).toEqual([token]);

    const id = deliveryId(event.eventId, user, 'push');
    expect(await statusOf(id)).toBe('delayed');
    expect(await timelineRows(id)).toContainEqual({
      status: 'delayed',
      detail: '2026-10-13T04:30:00.000Z',
    });
    expect(await wakeJobs(id)).toHaveLength(0); // the line's own delay is enough
    expect(t.providers.push.calls).toHaveLength(0); // nothing before the wake instant

    t.clock.advance(600_000);
    await line.release();
    await waitFor(async () => t.providers.push.callsTo(token).length === 1, {
      description: 'the push after the wake instant',
    });
    await waitForQueueEmpty(t, 'notify-push');
    expect(t.providers.push.callsTo(token)).toHaveLength(1);
  });

  it('S28 AS-31: a window ending in 2 hours schedules exactly one S49 job, even when the event is replayed; at wake the push joins the line', async () => {
    const user = await t.newUser();
    await kyivQuiet(user);
    const token = await addDevice(user);
    freezeAt('2026-10-13T02:30:00Z'); // 05:30 in Kyiv, the window ends 07:30 (04:30Z)
    line = holdExternalLines();

    const event = orderPaidEnvelope({ userId: user.id }, stamp());
    const id = deliveryId(event.eventId, user, 'push');
    await consume(t, [event]);
    await consume(t, [event]); // replay behind the done marker
    // and a replay that gets past the marker, as after a crash before it was written
    await t.app
      .get(RedisService)
      .client.del(
        redisKeys.done(
          identityOf(event.eventId, { kind: 'user', userId: user.id }),
        ),
      );
    await consume(t, [event]);

    expect(await inboxOf(user)).toHaveLength(1);
    const jobs = await wakeJobs(id);
    expect(jobs).toHaveLength(1);
    expect(
      Math.abs(jobs[0].runAt.getTime() - Date.parse('2026-10-13T04:30:00Z')),
    ).toBeLessThanOrEqual(1_000);
    expect(line.forChannel('push')).toHaveLength(0); // not on the line before the job fires
    expect(await statusOf(id)).toBe('delayed');

    // the job fires
    setAt('2026-10-13T04:30:00Z');
    await t.app
      .get(WakeDeliveryService, { strict: false })
      .wake({ deliveryId: id });
    const [push] = line.forChannel('push');
    expect(push.options.delaySeconds ?? 0).toBe(0);
    await line.release();
    await waitFor(async () => t.providers.push.callsTo(token).length === 1, {
      description: 'the push after the job fired',
    });
    await waitForQueueEmpty(t, 'notify-push');
    expect(t.providers.push.callsTo(token)).toHaveLength(1);
  });

  it('S28 AS-32: quiet hours hold push and SMS only; e-mail and the inbox are immediate; mandatory types and the phone verification SMS never wait', async () => {
    const user = await t.newUser();
    await kyivQuiet(user);
    await addDevice(user);
    await verifiedPhone(user);
    await optIn(user, 'orders', 'sms');
    freezeAt('2026-10-13T20:30:00Z'); // 23:30 in Kyiv, inside the window
    line = holdExternalLines();
    const jobsBefore = await allWakeJobs();

    const order = orderPaidEnvelope({ userId: user.id }, stamp());
    await consume(t, [order]);
    expect(await inboxOf(user)).toHaveLength(1);
    await waitFor(
      async () => t.providers.email.callsTo(user.email).length === 1,
      {
        description: 'the e-mail, sent at once',
      },
    );
    expect(
      await wakeJobs(deliveryId(order.eventId, user, 'email')),
    ).toHaveLength(0);
    for (const channel of ['push', 'sms']) {
      const id = deliveryId(order.eventId, user, channel);
      expect(await statusOf(id)).toBe('delayed');
      expect(await wakeJobs(id)).toHaveLength(1);
    }
    expect(line.held).toHaveLength(0);

    // a mandatory type: never delayed
    const changed = envelope(
      'identity.password_changed',
      { userId: user.id },
      stamp(),
    );
    await consume(t, [changed]);
    await waitFor(
      async () => t.providers.email.callsTo(user.email).length === 2,
      {
        description: 'the mandatory e-mail, sent at once',
      },
    );
    const mandatoryId = deliveryId(changed.eventId, user, 'email');
    expect(
      await timelineRows(mandatoryId).then((r) => r.map((x) => x.status)),
    ).not.toContain('delayed');
    expect(await wakeJobs(mandatoryId)).toHaveLength(0);

    // the phone verification code: SMS at once, in the same window
    await t.app
      .get(SettingsService, { strict: false })
      .update(user.id, { phone: '+380671112233' });
    // on the SMS line at once, with no delay
    const [code] = line.forChannel('sms');
    expect(line.held).toHaveLength(1);
    expect(code.message.type).toBe('security.phone_verification');
    expect(code.options.delaySeconds).toBeUndefined();
    await line.release();
    await waitFor(
      async () => t.providers.sms.callsTo('+380671112233').length === 1,
      { description: 'the verification SMS' },
    );
    expect(await allWakeJobs()).toBe(jobsBefore + 2); // only the order's push and SMS
  });

  it('S28 AS-34: a push held until the morning is dropped at the wake instant when its maximum age ended first; the inbox item stays', async () => {
    const user = await t.newUser();
    await kyivQuiet(user);
    const token = await addDevice(user);
    freezeAt('2026-10-13T02:30:00Z'); // the window ends at 04:30Z; auction.outbid is moot after 1 hour
    line = holdExternalLines();

    const event = envelope(
      'auction.leader_changed',
      {
        auctionId: v4(),
        previousLeaderId: user.id,
        priceMinor: 5_000,
        currency: 'USD',
        auctionVersion: 3,
      },
      stamp(),
    );
    const id = deliveryId(event.eventId, user, 'push');
    await consume(t, [event]);
    expect(await statusOf(id)).toBe('delayed');
    expect(await wakeJobs(id)).toHaveLength(1);

    setAt('2026-10-13T04:30:00Z');
    await t.app
      .get(WakeDeliveryService, { strict: false })
      .wake({ deliveryId: id });
    await line.release();

    expect(await statusOf(id)).toBe('expired');
    expect(line.held).toHaveLength(0);
    expect(t.providers.push.callsTo(token)).toHaveLength(0);
    expect(await inboxOf(user)).toHaveLength(1);
  });

  // ---- frequency caps ------------------------------------------------------------------------------------------------------

  it('S28 AS-35: the fourth marketing push within the hour is capped, all four inbox items exist, a transactional push is never capped', async () => {
    const author = v4();
    const user = await marketingUser(author);
    const token = await addDevice(user);
    freezeAt('2026-10-13T10:00:00Z');

    const events = Array.from({ length: 4 }, () => feedEvent(author));
    for (const ev of events) await consume(t, [ev]);

    for (const ev of events.slice(0, 3))
      expect(['queued', 'sent']).toContain(await capped(user, ev));
    expect(await capped(user, events[3])).toBe('capped');
    expect(await inboxOf(user)).toHaveLength(4);

    const order = orderPaidEnvelope({ userId: user.id }, stamp());
    await consume(t, [order]);
    expect(await capped(user, order, 'push')).not.toBe('capped');

    await waitFor(async () => t.providers.push.callsTo(token).length === 4, {
      description: 'three marketing pushes and the order push',
    });
    await waitForQueueEmpty(t, 'notify-marketing-push');
    expect(t.providers.push.callsTo(token)).toHaveLength(4);
    expect(
      t.providers.push.callsTo(token).filter((m) => m.priority === 'marketing'),
    ).toHaveLength(3);
  });

  it('S28 AS-36: 10 concurrent marketing events for one user queue exactly 3 and cap 7, in every one of 20 runs', async () => {
    freezeAt('2026-10-13T10:00:00Z');
    for (let run = 0; run < 20; run++) {
      const author = v4();
      const user = await marketingUser(author);
      await addDevice(user);
      const events = Array.from({ length: 10 }, () => feedEvent(author));
      await Promise.all(events.map((ev) => consume(t, [ev])));

      const statuses = await Promise.all(events.map((ev) => capped(user, ev)));
      expect(statuses.filter((s) => s === 'capped')).toHaveLength(7);
      expect(statuses.filter((s) => s !== 'capped')).toHaveLength(3);
      expect(
        await t.app
          .get(RedisService)
          .client.zcard(redisKeys.cap(user.id, 'push')),
      ).toBe(3);
    }
    await waitFor(async () => t.providers.push.calls.length === 60, {
      description: 'the 60 admitted pushes',
    });
    await waitForQueueEmpty(t, 'notify-marketing-push');
    expect(t.providers.push.calls).toHaveLength(60);
  });

  it('S28 AS-37: replaying the source events keeps the first decision of each delivery and takes no second slot', async () => {
    const author = v4();
    const user = await marketingUser(author);
    await addDevice(user);
    freezeAt('2026-10-13T10:00:00Z');
    const events = Array.from({ length: 4 }, () => feedEvent(author));
    for (const ev of events) await consume(t, [ev]);
    await waitFor(async () => t.providers.push.calls.length === 3, {
      description: 'the three admitted pushes',
    });

    const redis = t.app.get(RedisService).client;
    const caps = port<CapStore>(CAP_STORE);
    for (const ev of [events[0], events[3]]) {
      await consume(t, [ev]); // behind the done marker
      // past the marker (lost): the cap store itself must still answer with the first decision
      await redis.del(
        redisKeys.done(
          identityOf(ev.eventId, { kind: 'user', userId: user.id }),
        ),
      );
      await consume(t, [ev]);
    }
    expect(
      await caps.admit({
        userId: user.id,
        channel: 'push',
        deliveryId: deliveryId(events[0].eventId, user, 'push'),
        limit: 3,
        windowMs: 3_600_000,
        now: t.clock.now(),
      }),
    ).toBe('admit');
    expect(
      await caps.admit({
        userId: user.id,
        channel: 'push',
        deliveryId: deliveryId(events[3].eventId, user, 'push'),
        limit: 3,
        windowMs: 3_600_000,
        now: t.clock.now(),
      }),
    ).toBe('reject');

    expect(await capped(user, events[3])).toBe('capped');
    expect(await redis.zcard(redisKeys.cap(user.id, 'push'))).toBe(3);
    await waitForQueueEmpty(t, 'notify-marketing-push');
    expect(t.providers.push.calls).toHaveLength(3); // the replay of an admitted delivery sent nothing twice
  });

  it('S28 AS-38: the window rolls; push 3 per hour, e-mail 2 and SMS 1 per 24 hours, each counted per channel', async () => {
    const author = v4();
    const user = await marketingUser(author, ['push', 'email', 'sms']);
    await addDevice(user);
    await verifiedPhone(user);

    // push: three at 10:00:10, :30, :40; the 4th at 10:59:59 is capped; the 5th at 11:00:11 is admitted
    const sendAt = async (iso: string) => {
      freezeAt(iso);
      const ev = feedEvent(author);
      await consume(t, [ev]);
      return ev;
    };
    const first = await sendAt('2026-10-13T10:00:10Z');
    const second = await sendAt('2026-10-13T10:00:30Z');
    const third = await sendAt('2026-10-13T10:00:40Z');
    const fourth = await sendAt('2026-10-13T10:59:59Z');
    const fifth = await sendAt('2026-10-13T11:00:11Z');

    const push = (ev: { eventId: string }) => capped(user, ev, 'push');
    for (const ev of [first, second, third])
      expect(await push(ev)).not.toBe('capped');
    expect(await push(fourth)).toBe('capped');
    expect(await push(fifth)).not.toBe('capped');

    // e-mail 2 per 24 h and SMS 1 per 24 h, independent of push: admitted so far were the first and second, the first only
    const email = (ev: { eventId: string }) => capped(user, ev, 'email');
    const sms = (ev: { eventId: string }) => capped(user, ev, 'sms');
    expect(await email(first)).not.toBe('capped');
    expect(await email(second)).not.toBe('capped');
    expect(await email(third)).toBe('capped');
    expect(await sms(first)).not.toBe('capped');
    expect(await sms(second)).toBe('capped');

    // a day later (their first admit has left the window) they are admitted again
    const nextDay = await sendAt('2026-10-14T10:00:20Z');
    expect(await email(nextDay)).not.toBe('capped');
    expect(await sms(nextDay)).not.toBe('capped');
    expect(await push(nextDay)).not.toBe('capped');
  });

  it('S28 AS-39: with the cap store down marketing is not sent and the event is retried, transactional is unaffected; once the store returns the delivery is decided and queued once', async () => {
    const author = v4();
    const user = await marketingUser(author);
    const token = await addDevice(user);
    freezeAt('2026-10-13T10:00:00Z');
    const caps = port<CapStore>(CAP_STORE);
    const outage = faultSwitch(caps, ['admit']);
    try {
      outage.down(new Error('cap store unreachable'));

      const marketing = feedEvent(author);
      await expect(consume(t, [marketing])).rejects.toBeDefined(); // the framework retries the event
      const order = orderPaidEnvelope({ userId: user.id }, stamp());
      await consume(t, [order]);

      await waitFor(async () => t.providers.push.callsTo(token).length === 1, {
        description: 'the transactional push, unaffected',
      });
      expect(t.providers.push.callsTo(token)[0].priority).toBe('transactional');
      expect(await capped(user, marketing)).not.toBe('sent');
      expect(await capped(user, marketing)).not.toBe('capped');
      expect(t.providers.push.calls).toHaveLength(1);

      outage.up();
      await consume(t, [marketing]); // the retry
      await consume(t, [marketing]); // and a further redelivery
    } finally {
      outage.restore();
    }

    await waitFor(async () => t.providers.push.callsTo(token).length === 2, {
      description: 'the marketing push once the store is back',
    });
    await waitForQueueEmpty(t, 'notify-marketing-push');
    expect(t.providers.push.callsTo(token)).toHaveLength(2);
    expect(await inboxOf(user)).toHaveLength(2); // the marketing item (once) and the order confirmation
  });
});
