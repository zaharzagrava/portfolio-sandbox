import { randomUUID } from 'node:crypto';
import { v4 } from 'uuid';
import { InboxService } from './application/inbox.service';
import {
  CAP_STORE,
  CLAIM_STORE,
  COUNTER_STORE,
  DELIVERY_TIMELINE_STORE,
  DEVICE_REPOSITORY,
  INBOX_STORE,
  OTP_STORE,
  PREFERENCE_REPOSITORY,
  RECIPIENT_DIRECTORY,
  SETTINGS_REPOSITORY,
  SUPPRESSION_REPOSITORY,
  VERSION_GUARD_STORE,
  type CapStore,
  type ClaimStore,
  type CounterStore,
  type DeliveryTimelineStore,
  type DeviceRepository,
  type InboxStore,
  type OtpStore,
  type PreferenceRepository,
  type RecipientDirectory,
  type SettingsRepository,
  type SuppressionRepository,
  type VersionGuardStore,
} from './domain/ports';
import {
  createNotificationsApp,
  envelope,
  inParallel,
  orderPaidEnvelope,
  rawEnvelope,
  type NotificationsTestApp,
} from './testing';

/**
 * Foundation of S28 (phase 2): the ports against their real adapters (Postgres, wide-column store, Redis), the
 * migrations' constraints, and the fixtures themselves. Specs of the stories rely on these behaviours.
 */
describe('Notifications: foundation (ports, stores, fixtures)', () => {
  let t: NotificationsTestApp;
  const port = <T>(token: symbol) => t.app.get<T>(token, { strict: false });

  beforeAll(async () => {
    t = await createNotificationsApp({ workers: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => t.reset());

  it('S28 foundation: the app boots with real sessions and the routes answer for an owner only', async () => {
    const user = await t.newUser();
    const mine = await t.as(user).get('/api/notifications/unread-count');
    expect(mine.status).toBe(200);
    expect((await t.http().get('/api/notifications/unread-count')).status).toBe(
      401,
    );
  });

  it('S28 foundation: settings keep the quiet pair together and clear the verification when the phone changes', async () => {
    const settings = port<SettingsRepository>(SETTINGS_REPOSITORY);
    const user = await t.newUser();
    const now = t.clock.now();

    const first = await settings.update(
      user.id,
      {
        phone: '+380501112233',
        timezone: 'Europe/Kyiv',
        quietStart: '22:00',
        quietEnd: '07:00',
      },
      now,
    );
    expect(first).toMatchObject({
      phone: '+380501112233',
      timezone: 'Europe/Kyiv',
      phoneVerifiedAt: null,
    });
    expect(
      await settings.markPhoneVerified(user.id, '+380501112233', now),
    ).toBe(true);
    expect((await settings.find(user.id))?.phoneVerifiedAt).not.toBeNull();

    // same phone again: still verified; another phone: cleared in the same statement
    expect(
      (await settings.update(user.id, { phone: '+380501112233' }, now))
        .phoneVerifiedAt,
    ).not.toBeNull();
    expect(
      (await settings.update(user.id, { phone: '+380509998877' }, now))
        .phoneVerifiedAt,
    ).toBeNull();
    // a verification for a phone that is no longer the stored one is refused
    expect(
      await settings.markPhoneVerified(user.id, '+380501112233', now),
    ).toBe(false);

    // the store itself refuses a half-set window (CHECK ... NOT VALID then VALIDATEd)
    await expect(
      settings.update(
        user.id,
        { quietStart: '23:00', quietEnd: undefined },
        now,
      ),
    ).resolves.toBeDefined();
    await expect(
      settings.update(user.id, { quietStart: '23:00', quietEnd: null }, now),
    ).rejects.toThrow(/NotificationSettings_quiet_pair_check/);
    expect((await settings.findMany([user.id])).get(user.id)).toMatchObject({
      quietStart: '23:00',
      quietEnd: '07:00',
    });
  });

  it('S28 foundation: preference cells are idempotent overrides', async () => {
    const prefs = port<PreferenceRepository>(PREFERENCE_REPOSITORY);
    const user = await t.newUser();
    const now = t.clock.now();
    await Promise.all(
      [1, 2, 3].map(() => prefs.set(user.id, 'orders', 'email', false, now)),
    );
    await prefs.set(user.id, 'marketing', 'sms', true, now);
    expect(await prefs.overrides(user.id)).toEqual({
      'orders:email': false,
      'marketing:sms': true,
    });
    expect((await prefs.overridesMany([user.id, v4()])).size).toBe(1);
  });

  it('S28 foundation: devices move to the latest user, evict the oldest beyond the cap and delete by owner only', async () => {
    const devices = port<DeviceRepository>(DEVICE_REPOSITORY);
    const [a, b] = [await t.newUser(), await t.newUser()];
    const at = (i: number) => new Date(t.clock.now().getTime() + i * 1000);

    const first = await devices.register(
      { userId: a.id, token: 'tok-0', platform: 'ios' },
      3,
      at(0),
    );
    expect(first.created).toBe(true);
    for (let i = 1; i <= 3; i++)
      await devices.register(
        { userId: a.id, token: `tok-${i}`, platform: 'android' },
        3,
        at(i),
      );
    expect((await devices.list(a.id)).map((d) => d.token)).toEqual([
      'tok-3',
      'tok-2',
      'tok-1',
    ]);

    const known = await devices.register(
      { userId: a.id, token: 'tok-2', platform: 'web' },
      3,
      at(9),
    );
    expect(known).toMatchObject({
      created: false,
      device: { platform: 'web' },
    });

    const moved = await devices.register(
      { userId: b.id, token: 'tok-2', platform: 'web' },
      3,
      at(10),
    );
    expect(moved.device.id).toBe(known.device.id);
    expect((await devices.list(a.id)).map((d) => d.token)).toEqual([
      'tok-3',
      'tok-1',
    ]);

    expect(await devices.remove(a.id, moved.device.id)).toBe(false); // another user's id
    expect(await devices.remove(b.id, moved.device.id)).toBe(true);
    expect(await devices.remove(b.id, moved.device.id)).toBe(false);
  });

  it('S28 foundation: a suppression is recorded once and read back at once', async () => {
    const supp = port<SuppressionRepository>(SUPPRESSION_REPOSITORY);
    const now = t.clock.now();
    const address = `bounced-${v4()}@example.com`;
    expect(await supp.add('email', address, 'bounce', now)).toBe(true);
    expect(await supp.add('email', address, 'complaint', now)).toBe(false);
    expect([
      ...(await supp.suppressedAmong('email', [address, 'other@example.com'])),
    ]).toEqual([address]);
    expect((await supp.suppressedAmong('sms', [address])).size).toBe(0);
  });

  it('S28 foundation: the inbox inserts once, pages newest first, flips read once and counts through the watermark', async () => {
    const inbox = port<InboxStore>(INBOX_STORE);
    const user = await t.newUser();
    const now = t.clock.now();
    const range = { from: new Date(now.getTime() - 180 * 86_400_000), to: now };
    const item = (key: string, ageMs: number) => {
      const eventTime = new Date(now.getTime() - ageMs);
      return {
        id: InboxService.notificationId(key, user.id, eventTime).toString(),
        userId: user.id,
        type: 'order.confirmed',
        category: 'orders',
        title: 'Order confirmed',
        body: 'Body',
        link: '/orders/1',
        read: false,
        eventTime,
        arrivedAt: now,
      };
    };
    const [newest, middle, oldest] = [
      item('a', 1_000),
      item('b', 40 * 86_400_000),
      item('c', 100 * 86_400_000),
    ];
    expect(await inbox.insertIfAbsent(oldest)).toBe(true);
    expect(await inbox.insertIfAbsent(newest)).toBe(true);
    expect(await inbox.insertIfAbsent(middle)).toBe(true);
    expect(await inbox.insertIfAbsent(newest)).toBe(false);

    const page1 = await inbox.page(user.id, 2, null, range);
    expect(page1.map((i) => i.id)).toEqual([newest.id, middle.id]);
    const page2 = await inbox.page(
      user.id,
      2,
      { eventTime: page1[1].eventTime, id: page1[1].id },
      range,
    );
    expect(page2.map((i) => i.id)).toEqual([oldest.id]);
    expect(
      await inbox.page(user.id, 10, null, {
        from: new Date(now.getTime() - 50 * 86_400_000),
        to: now,
      }),
    ).toHaveLength(2);

    expect(
      await inbox.findOwned(user.id, [newest.id, 'not-a-uuid', v4()], range),
    ).toHaveLength(1);
    expect(await inbox.findOwned(v4(), [newest.id], range)).toHaveLength(0);

    expect(await inbox.countUnread(user.id, 1000, range)).toBe(3);
    const results = await inParallel(20, () => inbox.markRead(user.id, newest));
    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value).length,
    ).toBe(1);
    expect(await inbox.countUnread(user.id, 1000, range)).toBe(2);
    expect(await inbox.countUnread(user.id, 1, range)).toBe(1); // bounded

    await inbox.setReadAllBefore(user.id, new Date(now.getTime() + 1));
    expect(await inbox.readAllBefore(user.id)).toEqual(
      new Date(now.getTime() + 1),
    );
    expect(await inbox.countUnread(user.id, 1000, range)).toBe(0);
    const later = {
      ...item('d', 500),
      arrivedAt: new Date(now.getTime() + 5_000),
    };
    await inbox.insertIfAbsent(later);
    expect(await inbox.countUnread(user.id, 1000, range)).toBe(1);
  });

  it('S28 foundation: the delivery timeline moves forward by rank only and finds a delivery by provider id', async () => {
    const timeline = port<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE);
    const deliveryId = `d-${v4()}`;
    const at = (s: number) => new Date(t.clock.now().getTime() + s * 1000);
    await timeline.begin(
      {
        deliveryId,
        userId: v4(),
        channel: 'email',
        type: 'order.confirmed',
        line: 'transactional',
      },
      at(0),
    );
    await timeline.begin(
      {
        deliveryId,
        userId: v4(),
        channel: 'email',
        type: 'order.confirmed',
        line: 'transactional',
      },
      at(0),
    );
    expect((await timeline.find(deliveryId))?.status).toBe('queued');

    expect(
      await timeline.advance(deliveryId, {
        status: 'sent',
        provider: 'ses',
        providerMessageId: 'm-1',
        failover: true,
        at: at(1),
      }),
    ).toBe('sent');
    await timeline.linkProvider('ses', 'm-1', deliveryId);
    expect(await timeline.findByProvider('ses', 'm-1')).toBe(deliveryId);
    expect(await timeline.findByProvider('ses', 'unknown')).toBeNull();

    expect(
      await timeline.advance(deliveryId, { status: 'complained', at: at(3) }),
    ).toBe('complained');
    expect(
      await timeline.advance(deliveryId, { status: 'delivered', at: at(2) }),
    ).toBe('complained'); // never moves back
    expect(
      await timeline.advance(deliveryId, { status: 'bounced', at: at(4) }),
    ).toBe('complained');
    const summary = await timeline.find(deliveryId);
    expect(summary).toMatchObject({
      status: 'complained',
      provider: 'ses',
      providerMessageId: 'm-1',
    });

    // a pre-send terminal reaching the store before `begin` creates the summary at that status
    const early = `d-${v4()}`;
    expect(await timeline.advance(early, { status: 'capped', at: at(0) })).toBe(
      'capped',
    );
    expect((await timeline.find(early))?.status).toBe('capped');
  });

  it('S28 foundation: the cap admits exactly the limit under concurrency and the first decision is final', async () => {
    const cap = port<CapStore>(CAP_STORE);
    const userId = v4();
    const now = t.clock.now();
    const ids = Array.from({ length: 20 }, () => randomUUID());
    const run = (deliveryId: string, at = now) =>
      cap.admit({
        userId,
        channel: 'push',
        deliveryId,
        limit: 3,
        windowMs: 3_600_000,
        now: at,
      });

    const results = await inParallel(20, (i) => run(ids[i]));
    const decisions = results.map((r) =>
      r.status === 'fulfilled' ? r.value : 'error',
    );
    expect(decisions.filter((d) => d === 'admit')).toHaveLength(3);
    expect(decisions.filter((d) => d === 'reject')).toHaveLength(17);

    // replay: a delivery gets its first decision back, even after the window moved
    const admitted = ids[decisions.indexOf('admit')];
    const rejected = ids[decisions.indexOf('reject')];
    const later = new Date(now.getTime() + 2 * 3_600_000);
    expect(await run(admitted, later)).toBe('admit');
    expect(await run(rejected, later)).toBe('reject');
    // the rolling window frees room once the admits are older than an hour
    expect(await run(randomUUID(), later)).toBe('admit');
  });

  it('S28 foundation: the version guard drops lower versions and keeps the maximum', async () => {
    const guard = port<VersionGuardStore>(VERSION_GUARD_STORE);
    const id = v4();
    expect(await guard.admit('order', id, 3)).toBe(true);
    expect(await guard.admit('order', id, 2)).toBe(false);
    expect(await guard.admit('order', id, 3)).toBe(true);
    expect(await guard.admit('order', id, 5)).toBe(true);
    expect(await guard.admit('order', id, 4)).toBe(false);
    expect(await guard.admit('payment', id, 1)).toBe(true); // another family
  });

  it('S28 foundation: the unread counter is derived data that increments only when present, floors at zero and tracks dirty users', async () => {
    const counter = port<CounterStore>(COUNTER_STORE);
    const userId = v4();
    expect(await counter.get(userId)).toBeNull();
    await counter.increment(userId);
    expect(await counter.get(userId)).toBeNull(); // never creates the key
    await counter.set(userId, 2);
    await counter.increment(userId);
    expect(await counter.get(userId)).toBe(3);
    await counter.decrement(userId, 10);
    expect(await counter.get(userId)).toBe(0);

    const now = t.clock.now();
    await counter.markDirty(userId, now);
    await counter.markDirty(userId, new Date(now.getTime() + 60_000)); // the first mark stays
    expect(
      await counter.dirtyBefore(new Date(now.getTime() + 1), 10),
    ).toContain(userId);
    await counter.clearDirty(userId);
    expect(
      await counter.dirtyBefore(new Date(now.getTime() + 120_000), 1000),
    ).not.toContain(userId);
  });

  it('S28 foundation: a claim has one holder, a release by another worker does nothing, and a sent marker is kept', async () => {
    const claims = port<ClaimStore>(CLAIM_STORE);
    const deliveryId = v4();
    const won = await inParallel(20, (i) =>
      claims.claim(deliveryId, `w${i}`, 5_000),
    );
    expect(won.filter((r) => r.status === 'fulfilled' && r.value)).toHaveLength(
      1,
    );
    await claims.release(deliveryId, 'someone-else');
    expect(await claims.claim(deliveryId, 'w-new', 5_000)).toBe(false);
    expect(await claims.sentMarker(deliveryId)).toBeNull();
    await claims.markSent(deliveryId, 'prov-1');
    expect(await claims.sentMarker(deliveryId)).toBe('prov-1');
  });

  it('S28 foundation: one-time code state: replace, count failures, lock and clear', async () => {
    const otp = port<OtpStore>(OTP_STORE);
    const userId = v4();
    await otp.put(userId, 'mac-1', 600);
    expect(await otp.get(userId)).toBe('mac-1');
    expect(await otp.failAttempt(userId, 900)).toBe(1);
    expect(await otp.failAttempt(userId, 900)).toBe(2);
    await otp.put(userId, 'mac-2', 600); // a new code resets the attempts
    expect(await otp.failAttempt(userId, 900)).toBe(1);
    expect(await otp.lockedFor(userId)).toBe(0);
    await otp.lock(userId, 900);
    expect(await otp.lockedFor(userId)).toBeGreaterThan(890);
    expect(await otp.get(userId)).toBeNull();
    await otp.clear(userId);
  });

  it("S28 foundation: the directory resolves users and shop owners through the owners' services, batched", async () => {
    const dir = port<RecipientDirectory>(RECIPIENT_DIRECTORY);
    const [owner, other, member] = [
      await t.newUser(),
      await t.newUser(),
      await t.newUser(),
    ];
    const { shopId } = await t.seedShop([owner.id, other.id]);
    const empty = await t.seedShop([]);

    const users = await dir.users([owner.id, member.id, v4()]);
    expect([...users.keys()].sort()).toEqual([owner.id, member.id].sort());
    expect(users.get(owner.id)?.email).toBe(owner.email);

    const owners = await dir.shopOwners([shopId, empty.shopId, v4()]);
    expect([...(owners.get(shopId) ?? [])].sort()).toEqual(
      [owner.id, other.id].sort(),
    );
    expect(owners.get(empty.shopId)).toEqual([]);
  });

  it('S28 foundation: envelope builders produce schema-valid envelopes and refuse a payload the contract refuses', () => {
    const paid = orderPaidEnvelope({
      userId: v4(),
      shops: [
        { shopId: v4(), subtotalMinor: 1000 },
        { shopId: v4(), subtotalMinor: 500 },
      ],
    });
    expect(paid).toMatchObject({
      type: 'order.paid',
      aggregateType: 'orders',
      version: 1,
    });
    expect(
      (paid.payload as { shopOrders: unknown[]; totalMinor: number })
        .shopOrders,
    ).toHaveLength(2);
    expect((paid.payload as { totalMinor: number }).totalMinor).toBe(1500);
    expect(() => envelope('identity.password_changed', {} as never)).toThrow();
    expect(rawEnvelope('order.paid', { bogus: true }).payload).toEqual({
      bogus: true,
    });
  });
});
