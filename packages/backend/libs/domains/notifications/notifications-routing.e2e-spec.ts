import { v4, v7 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import {
  PASSWORD_RESET_MAILER,
  UserDirectoryService,
} from '@app/domains/identity';
import type { PasswordResetMailer } from '@app/domains/identity';
import { MembershipQueryService } from '@app/domains/tenancy';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  DEAD_LETTER_SINK,
  DELIVERY_LINE_PRODUCER,
  DELIVERY_TIMELINE_STORE,
  DEVICE_REPOSITORY,
  PREFERENCE_REPOSITORY,
  SETTINGS_REPOSITORY,
  SUPPRESSION_REPOSITORY,
  type DeadLetterSink,
  type DeliveryTimelineStore,
  type DeviceRepository,
  type PreferenceRepository,
  type SettingsRepository,
  type SuppressionRepository,
} from './domain/ports';
import { deliveryIdFor, identityOf } from './domain/ids';
import {
  capturingLogs,
  consume,
  consumeInvite,
  createNotificationsApp,
  envelope,
  faultSwitch,
  orderPaidEnvelope,
  rawEnvelope,
  waitFor as waitForSoon,
  waitForQueueEmpty,
  type NotificationsTestApp,
  type TestUser,
} from './testing';
import type { DeliveryLineProducer } from './domain/ports';

/**
 * Waits for the line workers. A queue receive abandoned by an app of an earlier run can swallow a message for up to one
 * visibility timeout (5 s), so the wait is longer than the default.
 */
const waitFor: typeof waitForSoon = (probe, options = {}) =>
  waitForSoon(probe, { timeoutMs: 45_000, ...options });

const ignored = (reason: string) =>
  MetricsRegistry.value('notifications_events_ignored_total', { reason }) ?? 0;
const staleDropped = (family: string) =>
  MetricsRegistry.value('notifications_stale_version_dropped_total', {
    family,
  }) ?? 0;

describe('Notifications: event routing, recipients and exactly-once', () => {
  let t: NotificationsTestApp;
  const port = <T>(token: symbol) => t.app.get<T>(token, { strict: false });
  const front = () =>
    t.app.get(ApiConfigService).get('front_host').replace(/\/$/, '');

  beforeAll(async () => {
    t = await createNotificationsApp({ env: { EMAIL_PROVIDER: 'memory' } });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => t.reset());

  const inboxOf = async (user: TestUser) =>
    (await t.as(user).get('/api/notifications').expect(200)).body
      .items as Array<Record<string, unknown>>;
  const unreadOf = async (user: TestUser) =>
    (await t.as(user).get('/api/notifications/unread-count').expect(200)).body
      .unread as number;
  const deliveryId = (eventId: string, userId: string, channel: string) =>
    deliveryIdFor(identityOf(eventId, { kind: 'user', userId }), channel);
  const timelineStatuses = async (id: string) =>
    (
      await t.app
        .get(CassandraService)
        .execute('SELECT status FROM delivery_timeline WHERE delivery_id = ?', [
          id,
        ])
    ).rows.map((r) => r.get('status') as string);
  const deadLettersOf = async (eventId: string) =>
    (await port<DeadLetterSink>(DEAD_LETTER_SINK).recent(500)).filter(
      (l) => l.eventId === eventId,
    );
  const setLocale = (user: TestUser, locale: string) =>
    port<SettingsRepository>(SETTINGS_REPOSITORY).update(
      user.id,
      { locale },
      t.clock.now(),
    );
  const addDevice = (user: TestUser, token: string) =>
    port<DeviceRepository>(DEVICE_REPOSITORY).register(
      { userId: user.id, token, platform: 'ios' },
      10,
      t.clock.now(),
    );
  const emailsTo = (address: string) => t.providers.email.callsTo(address);

  it('S28 AS-01: order.paid gives the buyer one unread inbox item, one e-mail, one live event and the owners their own item', async () => {
    const buyer = await t.newUser();
    const owner = await t.newUser();
    const { shopId } = await t.seedShop([owner.id]);
    await setLocale(buyer, 'uk');
    const event = orderPaidEnvelope({
      userId: buyer.id,
      orderVersion: 3,
      totalMinor: 129_900,
      currency: 'USD',
      shops: [{ shopId, subtotalMinor: 129_900 }],
    });
    const orderId = event.aggregateId;

    await consume(t, [event]);

    const items = await inboxOf(buyer);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'order.confirmed',
      category: 'orders',
      read: false,
      link: `/orders/${orderId}`,
      title: 'Замовлення підтверджено',
    });
    expect(items[0].body).toMatch(/1\s299,00/);
    expect(await unreadOf(buyer)).toBe(1);

    const [mail] = await waitFor(
      async () => emailsTo(buyer.email).length === 1 && emailsTo(buyer.email),
      { description: 'the confirmation e-mail' },
    );
    expect(mail.subject).toMatch(/^Ваше замовлення .+ підтверджено$/);
    expect(mail.html).toContain('Дякуємо за замовлення!');
    expect(mail.unsubscribeUrl).toMatch(
      /\/api\/notifications\/unsubscribe\?token=/,
    );

    const id = deliveryId(event.eventId, buyer.id, 'email');
    expect(mail.deliveryId).toBe(id);
    await waitFor(
      async () =>
        (await port<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE).find(id))
          ?.status === 'sent',
      { description: 'the delivery to be sent' },
    );
    expect(await timelineStatuses(id)).toEqual(['queued', 'sent']);

    const live = t.realtime.to(buyer.id);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      type: 'notification',
      data: { id: items[0].id, type: 'order.confirmed', unread: true },
    });

    // the owner of the shop hears about their part of the order
    const ownerItems = await inboxOf(owner);
    expect(ownerItems).toHaveLength(1);
    expect(ownerItems[0]).toMatchObject({
      type: 'shop.order_received',
      category: 'shop',
    });
  });

  it('S28 AS-02: a second delivery and 20 concurrent deliveries create exactly one of everything', async () => {
    const first = await t.newUser();
    const second = await t.newUser();

    const event = orderPaidEnvelope({ userId: first.id });
    await consume(t, [event]);
    await consume(t, [event]);

    const concurrent = orderPaidEnvelope({ userId: second.id });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => consume(t, [concurrent])),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    await waitFor(
      async () =>
        emailsTo(first.email).length >= 1 && emailsTo(second.email).length >= 1,
      { description: 'both e-mails' },
    );
    await waitForQueueEmpty(t, 'notify-email');

    for (const [user, ev] of [
      [first, event],
      [second, concurrent],
    ] as const) {
      expect(await inboxOf(user)).toHaveLength(1);
      expect(await unreadOf(user)).toBe(1);
      expect(emailsTo(user.email)).toHaveLength(1);
      expect(t.realtime.to(user.id)).toHaveLength(1);
      expect(
        await timelineStatuses(deliveryId(ev.eventId, user.id, 'email')),
      ).toEqual(['queued', 'sent']);
    }
  });

  it('S28 AS-03: a queue that refuses once leaves the earlier steps intact and the replay ends in the same state as one clean run', async () => {
    const buyer = await t.newUser();
    const event = orderPaidEnvelope({ userId: buyer.id });
    const producer = port<DeliveryLineProducer>(DELIVERY_LINE_PRODUCER);
    const refuse = faultSwitch(producer, ['enqueue']);
    try {
      refuse.down(new Error('queue refuses'));
      await expect(consume(t, [event])).rejects.toBeDefined();
      // the inbox item was stored before the hand-off failed
      expect(await inboxOf(buyer)).toHaveLength(1);
      expect(emailsTo(buyer.email)).toHaveLength(0);

      refuse.up();
      await consume(t, [event]);
    } finally {
      refuse.restore();
    }

    await waitFor(async () => emailsTo(buyer.email).length === 1, {
      description: 'the e-mail after the replay',
    });
    await waitForQueueEmpty(t, 'notify-email');
    expect(await inboxOf(buyer)).toHaveLength(1);
    expect(await unreadOf(buyer)).toBe(1);
    expect(emailsTo(buyer.email)).toHaveLength(1);
    expect(t.realtime.to(buyer.id)).toHaveLength(1);
    expect(
      await timelineStatuses(deliveryId(event.eventId, buyer.id, 'email')),
    ).toEqual(['queued', 'sent']);
  });

  it('S28 AS-04: an invalid payload is dead-lettered with its reason while the other events of the batch complete', async () => {
    const [a, bad, c] = [
      await t.newUser(),
      await t.newUser(),
      await t.newUser(),
    ];
    const first = orderPaidEnvelope({ userId: a.id });
    const third = orderPaidEnvelope({ userId: c.id });
    const valid = orderPaidEnvelope({ userId: bad.id });
    const broken = rawEnvelope(
      'order.paid',
      { ...valid.payload, totalMinor: 'a lot' },
      { eventId: valid.eventId, aggregateId: valid.aggregateId },
    );

    await consume(t, [first, broken, third]);

    expect(await deadLettersOf(broken.eventId)).toMatchObject([
      { reason: 'invalid_payload', source: 'orders', type: 'order.paid' },
    ]);
    expect(await inboxOf(bad)).toHaveLength(0);
    expect(await inboxOf(a)).toHaveLength(1);
    expect(await inboxOf(c)).toHaveLength(1);
    await waitFor(
      async () =>
        emailsTo(a.email).length === 1 && emailsTo(c.email).length === 1,
      { description: 'the two valid e-mails' },
    );
    await waitForQueueEmpty(t, 'notify-email');
    expect(emailsTo(bad.email)).toHaveLength(0);
    expect(
      await port<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE).find(
        deliveryId(broken.eventId, bad.id, 'email'),
      ),
    ).toBeNull();
  });

  it('S28 AS-05: an unmapped type is counted and ignored, an unsupported version is dead-lettered', async () => {
    const buyer = await t.newUser();
    const reserved = rawEnvelope(
      'order.reserved',
      { orderId: v4(), userId: buyer.id },
      { eventId: v7() },
    );
    const before = ignored('unmapped');
    await consume(t, [reserved]);
    expect(ignored('unmapped')).toBe(before + 1);
    expect(await deadLettersOf(reserved.eventId)).toEqual([]);
    expect(await inboxOf(buyer)).toHaveLength(0);

    const valid = orderPaidEnvelope({ userId: buyer.id });
    const future = rawEnvelope('order.paid', valid.payload as never, {
      eventId: valid.eventId,
      aggregateId: valid.aggregateId,
      version: 99,
    });
    await consume(t, [future]);
    expect(await deadLettersOf(future.eventId)).toMatchObject([
      { reason: 'unsupported_version', type: 'order.paid' },
    ]);
    expect(await inboxOf(buyer)).toHaveLength(0);
  });

  it('S28 AS-06: an unknown user produces nothing; a user without an e-mail address still gets the inbox item and the push', async () => {
    const before = ignored('recipient_not_found');
    const ghost = orderPaidEnvelope({ userId: v4() });
    await expect(consume(t, [ghost])).resolves.toBeUndefined();
    expect(ignored('recipient_not_found')).toBe(before + 1);
    expect(await deadLettersOf(ghost.eventId)).toEqual([]);

    const noMail = await t.newUser({ withoutEmail: true });
    await addDevice(noMail, 'tok-no-mail');
    const event = orderPaidEnvelope({ userId: noMail.id });
    await expect(consume(t, [event])).resolves.toBeUndefined();

    expect(await inboxOf(noMail)).toHaveLength(1);
    await waitFor(
      async () => t.providers.push.callsTo('tok-no-mail').length === 1,
      { description: 'the push' },
    );
    expect(
      await port<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE).find(
        deliveryId(event.eventId, noMail.id, 'email'),
      ),
    ).toBeNull();
  });

  it('S28 AS-07: shop owners are resolved once per batch, STAFF are not told, and a replay creates nothing new', async () => {
    const [ownerA, ownerB, staff] = [
      await t.newUser(),
      await t.newUser(),
      await t.newUser(),
    ];
    const s1 = await t.seedShop([ownerA.id, ownerB.id], {
      staffIds: [staff.id],
    });
    const others: Array<{ shopId: string }> = [];
    for (let i = 0; i < 11; i++)
      others.push(await t.seedShop([(await t.newUser()).id]));

    const payout = (shopId: string) =>
      envelope('payout.paid', {
        payoutId: v4(),
        shopId,
        amountMinor: 50_000,
        currency: 'USD',
        payoutVersion: 2,
      });
    const batch = [
      payout(s1.shopId),
      ...Array.from({ length: 39 }, (_, i) =>
        payout(others[i % others.length].shopId),
      ),
    ];

    const memberships = jest.spyOn(
      t.app.get(MembershipQueryService),
      'getMembersByShopIds',
    );
    const directory = jest.spyOn(
      t.app.get(UserDirectoryService),
      'getUsersByIds',
    );
    try {
      await consume(t, batch);
      expect(memberships).toHaveBeenCalledTimes(1);
      expect(memberships.mock.calls[0][0]).toHaveLength(12);
      expect(directory).toHaveBeenCalledTimes(1);
    } finally {
      memberships.mockRestore();
      directory.mockRestore();
    }

    for (const owner of [ownerA, ownerB]) {
      const items = await inboxOf(owner);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: 'payout.paid',
        category: 'payouts',
      });
    }
    expect(await inboxOf(staff)).toHaveLength(0);

    await consume(t, batch);
    expect(await inboxOf(ownerA)).toHaveLength(1);
    expect(await inboxOf(ownerB)).toHaveLength(1);
    expect(await unreadOf(ownerA)).toBe(1);
  });

  it('S28 AS-08: an invitation goes to its address once, with the invite link, no inbox item, and still obeys the suppression list', async () => {
    const inviter = await t.newUser();
    const { shopId } = await t.seedShop([inviter.id]);
    const body = (inviteId: string, email: string, token: string) => ({
      inviteId,
      shopId,
      shopName: 'Lamps & Co',
      email,
      role: 'STAFF',
      token,
      expiresAt: new Date(t.clock.now().getTime() + 86_400_000).toISOString(),
      invitedBy: inviter.id,
    });

    // through the real queue, end to end
    const invite = body(v4(), 'new@mail.com', 'T-first');
    await t.app.get(TaskQueue).enqueue('tenancy-invite-requested', invite);
    const [mail] = await waitFor(
      async () =>
        emailsTo('new@mail.com').length === 1 && emailsTo('new@mail.com'),
      { description: 'the invitation e-mail' },
    );
    expect(mail.html).toContain(`${front()}/invites/T-first`);
    expect(mail.body).toContain(`${front()}/invites/T-first`);
    expect(mail.unsubscribeUrl).toBeUndefined();

    // delivered again (twice, at once): still one e-mail
    await Promise.all([
      consumeInvite(t, invite, 'm-2'),
      consumeInvite(t, invite, 'm-3'),
    ]);
    await waitForQueueEmpty(t, 'notify-email');
    expect(emailsTo('new@mail.com')).toHaveLength(1);

    // a suppressed address is never handed to a provider
    await port<SuppressionRepository>(SUPPRESSION_REPOSITORY).add(
      'email',
      'blocked@mail.com',
      'manual',
      t.clock.now(),
    );
    const blocked = body(v4(), 'Blocked@Mail.com', 'T-blocked');
    await consumeInvite(t, blocked);
    const id = deliveryIdFor(
      identityOf(blocked.inviteId, { kind: 'address', email: blocked.email }),
      'email',
    );
    await waitFor(
      async () =>
        (await port<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE).find(id))
          ?.status === 'suppressed',
      { description: 'the suppressed status' },
    );
    expect(emailsTo('blocked@mail.com')).toHaveLength(0);
  });

  it('S28 AS-09: a reset token travels once, in the mail itself: never in logs, timeline, metrics or a dead-letter record', async () => {
    const user = await t.newUser();
    const prefs = port<PreferenceRepository>(PREFERENCE_REPOSITORY);
    for (const channel of ['email', 'inapp', 'push', 'sms'] as const)
      await prefs.set(user.id, 'security', channel, false, t.clock.now());

    const token = `RESET-${v4()}`;
    const inviteToken = `INVITE-${v4()}`;
    const previousFlag = process.env.DEV_MAILBOX_ENABLED;
    process.env.DEV_MAILBOX_ENABLED = 'true';
    try {
      const { logged } = await capturingLogs(async () => {
        await t.app
          .get<PasswordResetMailer>(PASSWORD_RESET_MAILER)
          .sendResetLink({
            to: user.email,
            link: `${front()}/reset-password#token=${token}`,
            expiresAt: new Date(t.clock.now().getTime() + 30 * 60_000),
          });
        // a valid invitation carrying a token, and a malformed one that must be dead-lettered without its body
        const good = {
          inviteId: v4(),
          shopId: v4(),
          shopName: 'Shop',
          email: 'invitee@mail.com',
          role: 'STAFF',
          token: inviteToken,
          expiresAt: t.clock.now().toISOString(),
          invitedBy: user.id,
        };
        await consumeInvite(t, good, 'msg-good');
        await consumeInvite(t, { ...good, email: undefined }, 'msg-bad');
        await waitFor(async () => emailsTo('invitee@mail.com').length === 1, {
          description: 'the invitation',
        });
        return good;
      });

      const mailbox = await t
        .http()
        .get('/api/dev/mailbox')
        .query({ to: user.email })
        .expect(200);
      expect(mailbox.body.messages).toHaveLength(1);
      expect(mailbox.body.messages[0].links).toEqual([
        `${front()}/reset-password#token=${token}`,
      ]);
      expect(await inboxOf(user)).toHaveLength(0);

      const letters = await port<DeadLetterSink>(DEAD_LETTER_SINK).recent(500);
      const bad = letters.filter((l) => l.eventId === 'msg-bad');
      expect(bad).toMatchObject([{ reason: 'invalid_payload' }]);

      const surfaces = [
        logged,
        JSON.stringify(letters),
        JSON.stringify(
          Object.keys(
            // every counter label set that exists in this process
            Object.fromEntries(
              [
                'notifications_events_consumed_total',
                'notifications_events_ignored_total',
                'notifications_dead_letter_total',
                'notifications_inbox_created_total',
                'notifications_delivery_total',
              ].flatMap((name) =>
                MetricsRegistry.labelSets(name).map((l) => [
                  JSON.stringify(l),
                  1,
                ]),
              ),
            ),
          ),
        ),
        JSON.stringify(
          (
            await t.app
              .get(CassandraService)
              .execute('SELECT detail FROM delivery_timeline LIMIT 1000')
          ).rows.map((r) => r.get('detail')),
        ),
      ];
      for (const surface of surfaces) {
        expect(surface).not.toContain(token);
        expect(surface).not.toContain(inviteToken);
      }
    } finally {
      if (previousFlag === undefined) delete process.env.DEV_MAILBOX_ENABLED;
      else process.env.DEV_MAILBOX_ENABLED = previousFlag;
    }
  });

  it('S28 AS-10: an event with a lower version than the last notified one is dropped, a higher one is processed', async () => {
    const [winner, outbid, laterOutbid, buyer] = [
      await t.newUser(),
      await t.newUser(),
      await t.newUser(),
      await t.newUser(),
    ];
    const auctionId = v4();
    const orderId = v4();
    const closed = envelope('auction.closed', {
      auctionId,
      shopId: v4(),
      winnerId: winner.id,
      finalPriceMinor: 70_000,
      currency: 'USD',
      auctionVersion: 7,
    });
    const leader = (previousLeaderId: string, auctionVersion: number) =>
      envelope('auction.leader_changed', {
        auctionId,
        previousLeaderId,
        priceMinor: 65_000,
        currency: 'USD',
        auctionVersion,
      });
    const dropped = staleDropped('auction');

    await consume(t, [closed]);
    await consume(t, [leader(outbid.id, 6)]);
    expect(await inboxOf(winner)).toHaveLength(1);
    expect(await inboxOf(outbid)).toHaveLength(0);
    expect(staleDropped('auction')).toBe(dropped + 1);

    await consume(t, [leader(laterOutbid.id, 8)]);
    expect(await inboxOf(laterOutbid)).toHaveLength(1);

    const status = (deliveryVersion: number, state: string) =>
      envelope('delivery.status_changed', {
        buyerId: buyer.id,
        orderId,
        status: state,
        deliveryVersion,
      });
    await consume(t, [status(4, 'DELIVERED')]);
    await consume(t, [status(3, 'PICKED_UP')]);
    expect(await inboxOf(buyer)).toHaveLength(0);
    await consume(t, [status(5, 'CANCELLED')]);
    expect(await inboxOf(buyer)).toMatchObject([
      { type: 'delivery.cancelled' },
    ]);
  });

  it('S28 AS-11: a stale event keeps its inbox item but sends nothing external and is recorded expired', async () => {
    const [stale, fresh] = [await t.newUser(), await t.newUser()];
    await addDevice(stale, 'tok-stale');
    await addDevice(fresh, 'tok-fresh');
    const now = t.clock.now().getTime();
    const outbid = (userId: string, ageMs: number) =>
      envelope(
        'auction.leader_changed',
        {
          auctionId: v4(),
          previousLeaderId: userId,
          priceMinor: 65_000,
          currency: 'USD',
          auctionVersion: 3,
        },
        { occurredAt: new Date(now - ageMs) },
      );
    const old = outbid(stale.id, 2 * 3_600_000);
    const recent = outbid(fresh.id, 5 * 60_000);

    await consume(t, [old, recent]);

    expect(await inboxOf(stale)).toHaveLength(1);
    const id = deliveryId(old.eventId, stale.id, 'push');
    expect(
      (await port<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE).find(id))
        ?.status,
    ).toBe('expired');
    await waitFor(
      async () => t.providers.push.callsTo('tok-fresh').length === 1,
      { description: 'the fresh push' },
    );
    expect(t.providers.push.callsTo('tok-stale')).toHaveLength(0);
  });

  it('S28 AS-12: a request that cannot be rendered is dead-lettered alone and leaves no side effect', async () => {
    const [broken, fine] = [await t.newUser(), await t.newUser()];
    // a currency code Intl rejects: the amount cannot be rendered
    const bad = orderPaidEnvelope({ userId: broken.id, currency: 'US' });
    const good = orderPaidEnvelope({ userId: fine.id });

    const { logged } = await capturingLogs(() => consume(t, [bad, good]));

    expect(await deadLettersOf(bad.eventId)).toMatchObject([
      { reason: 'render_failed', type: 'order.paid' },
    ]);
    expect(await inboxOf(broken)).toHaveLength(0);
    expect(await unreadOf(broken)).toBe(0);
    expect(
      await port<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE).find(
        deliveryId(bad.eventId, broken.id, 'email'),
      ),
    ).toBeNull();
    expect(await inboxOf(fine)).toHaveLength(1);
    await waitFor(async () => emailsTo(fine.email).length === 1, {
      description: 'the second event',
    });
    expect(emailsTo(broken.email)).toHaveLength(0);
    expect(logged).not.toContain(broken.email);
    expect(logged).not.toContain(broken.id);
  });
});
