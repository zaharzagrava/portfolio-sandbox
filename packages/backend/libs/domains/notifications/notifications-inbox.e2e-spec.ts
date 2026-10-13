import { Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { v4 } from 'uuid';
import {
  notificationItemSchema,
  notificationPageSchema,
  unreadCountSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JOB_HANDLER_METADATA } from '@app/infrastructure/jobs/job-handler.decorator';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { UnreadReconcileService } from './application/unread-reconcile.service';
import { inboxItemIdFor } from './domain/ids';
import {
  COUNTER_STORE,
  DEVICE_REPOSITORY,
  INBOX_STORE,
  SETTINGS_REPOSITORY,
  type CounterStore,
  type DeviceRepository,
  type InboxStore,
  type SettingsRepository,
} from './domain/ports';
import {
  consume,
  createNotificationsApp,
  envelope,
  faultSwitch,
  orderPaidEnvelope,
  waitFor as waitForSoon,
  type NotificationsTestApp,
  type TestUser,
} from './testing';

const waitFor: typeof waitForSoon = (probe, options = {}) =>
  waitForSoon(probe, { timeoutMs: 45_000, ...options });

const DAY = 86_400_000;
const HOUR = 3_600_000;
const realtimeFailures = () =>
  MetricsRegistry.value('notifications_realtime_publish_failed_total', {}) ?? 0;

describe('Notifications: inbox and unread counter', () => {
  let t: NotificationsTestApp;
  const port = <T>(token: symbol) => t.app.get<T>(token, { strict: false });
  const store = () => port<InboxStore>(INBOX_STORE);
  const counter = () => port<CounterStore>(COUNTER_STORE);

  beforeAll(async () => {
    t = await createNotificationsApp({ env: { EMAIL_PROVIDER: 'memory' } });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => t.reset());

  let seq = 0;
  /** An inbox row written straight to the store (the counter is left alone: it is rebuilt on the first count). */
  const addItem = async (
    user: TestUser,
    over: { eventTime?: Date; read?: boolean; arrivedAt?: Date } = {},
  ): Promise<string> => {
    const n = ++seq;
    const eventTime =
      over.eventTime ?? new Date(t.clock.now().getTime() - 1_000 - n);
    const id = inboxItemIdFor(`seed-${n}-${v4()}|${user.id}`, eventTime);
    await store().insertIfAbsent({
      id,
      userId: user.id,
      type: 'order.confirmed',
      category: 'orders',
      title: `Item ${n}`,
      body: 'Body',
      link: `/orders/${v4()}`,
      read: over.read ?? false,
      eventTime,
      arrivedAt: over.arrivedAt ?? t.clock.now(),
    });
    return id;
  };
  const list = (user: TestUser, query = '') =>
    t.as(user).get(`/api/notifications${query}`);
  const page = async (user: TestUser, query = '') =>
    notificationPageSchema.parse((await list(user, query).expect(200)).body);
  const unreadOf = async (user: TestUser) =>
    unreadCountSchema.parse(
      (await t.as(user).get('/api/notifications/unread-count').expect(200))
        .body,
    ).unread;
  const markRead = (user: TestUser, body: unknown) =>
    t
      .as(user)
      .post('/api/notifications/read')
      .send(body as object);
  const dropCounter = async (user: TestUser) => {
    const redis = t.app.get(RedisService).client;
    const keys = await redis.keys(`*unread:{${user.id}}`);
    if (keys.length > 0) await redis.del(...keys);
  };
  const monthStart = (monthsBack: number) => {
    const now = t.clock.now();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1);
  };

  it('S28 AS-55: 45 items over two months page as 20, 20 and 5, newest first, with nothing repeated, skipped or foreign', async () => {
    const user = await t.newUser();
    const other = await t.newUser();
    const boundary = monthStart(1);
    const seeded: string[] = [];
    for (let i = 0; i < 22; i++)
      seeded.push(
        await addItem(user, { eventTime: new Date(boundary - (i + 1) * HOUR) }),
      );
    for (let i = 0; i < 23; i++)
      // two items of the same instant: the tie is broken by id and neither is lost at a page edge
      seeded.push(
        await addItem(user, {
          eventTime: new Date(boundary + Math.max(i - 1, 0) * HOUR),
        }),
      );
    const foreign: string[] = [];
    for (let i = 0; i < 5; i++) foreign.push(await addItem(other));

    const pages = [await page(user, '?limit=20')];
    while (pages[pages.length - 1].nextCursor)
      pages.push(
        await page(
          user,
          `?limit=20&cursor=${encodeURIComponent(pages[pages.length - 1].nextCursor!)}`,
        ),
      );

    expect(pages.map((p) => p.items.length)).toEqual([20, 20, 5]);
    expect(pages[2].nextCursor).toBeNull();
    const all = pages.flatMap((p) => p.items);
    expect(all.map((i) => i.id).sort()).toEqual([...seeded].sort());
    expect(new Set(all.map((i) => i.id)).size).toBe(45);
    for (const id of foreign) expect(all.map((i) => i.id)).not.toContain(id);
    const times = all.map((i) => Date.parse(i.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(
      new Set(all.map((i) => new Date(i.createdAt).getUTCMonth())).size,
    ).toBe(2);
    expect(all.every((i) => !i.read)).toBe(true);
  });

  it('S28 AS-56: limits, cursors and credentials are checked, the default page is 20, and the read policy answers 429 with Retry-After', async () => {
    const user = await t.newUser();
    const other = await t.newUser();
    for (let i = 0; i < 25; i++) await addItem(user);
    for (let i = 0; i < 3; i++) await addItem(other);

    for (const bad of ['limit=0', 'limit=51', 'limit=abc']) {
      const res = await list(user, `?${bad}`).expect(400);
      expect(res.body.code).toBe('validation_failed');
    }
    const first = await page(user);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();

    const foreignPage = await page(other, '?limit=1');
    for (const cursor of [
      'garbage',
      'a.b',
      foreignPage.nextCursor!,
      first.nextCursor!.slice(0, -2) + 'xx',
    ]) {
      const res = await list(
        user,
        `?cursor=${encodeURIComponent(cursor)}`,
      ).expect(400);
      if (cursor === foreignPage.nextCursor || cursor === 'garbage') {
        expect(res.body.code).toBe('invalid_cursor');
        expect(JSON.stringify(res.body)).not.toContain('Item');
      }
    }
    const refused = await list(
      user,
      `?cursor=${encodeURIComponent(foreignPage.nextCursor!)}`,
    ).expect(400);
    expect(refused.body.code).toBe('invalid_cursor');
    expect(refused.headers['content-type']).toContain('problem+json');

    await t.http().get('/api/notifications').expect(401);
    await t.http().get('/api/notifications/unread-count').expect(401);

    const limited = await newUserCalls();
    expect(limited.filter((s) => s.status === 429).length).toBeGreaterThan(0);
    expect(limited.filter((s) => s.status === 200).length).toBeLessThanOrEqual(
      126,
    );
    expect(
      Number(limited.find((s) => s.status === 429)!.retryAfter),
    ).toBeGreaterThan(0);

    async function newUserCalls() {
      const busy = await t.newUser();
      return Promise.all(
        Array.from({ length: 130 }, (_, i) =>
          (i % 2 === 0
            ? t.as(busy).get('/api/notifications')
            : t.as(busy).get('/api/notifications/unread-count')
          ).then((r) => ({
            status: r.status,
            retryAfter: r.headers['retry-after'],
          })),
        ),
      );
    }
  });

  it('S28 AS-57: the unread count is the number of unread items; no credentials is 401', async () => {
    const user = await t.newUser();
    for (let i = 0; i < 3; i++) await addItem(user);
    for (let i = 0; i < 2; i++) await addItem(user, { read: true });

    const res = await t.as(user).get('/api/notifications/unread-count');
    expect(res.status).toBe(200);
    expect(unreadCountSchema.parse(res.body)).toEqual({ unread: 3 });
    await t.http().get('/api/notifications/unread-count').expect(401);
  });

  it('S28 AS-58: two tabs marking one item read at once drop the count by exactly one, 20 times over', async () => {
    for (let round = 0; round < 20; round++) {
      const user = await t.newUser();
      const target = await addItem(user);
      await addItem(user);
      await addItem(user);
      expect(await unreadOf(user)).toBe(3);

      const answers = await Promise.all([
        markRead(user, { ids: [target] }),
        markRead(user, { ids: [target] }),
      ]);
      expect(answers.map((a) => a.status)).toEqual([200, 200]);
      expect(answers.map((a) => unreadCountSchema.parse(a.body))).toEqual([
        { unread: 2 },
        { unread: 2 },
      ]);
      expect(await unreadOf(user)).toBe(2);
      const again = await markRead(user, { ids: [target] }).expect(200);
      expect(again.body).toEqual({ unread: 2 });
      const items = (await page(user)).items;
      expect(items.find((i) => i.id === target)!.read).toBe(true);
      expect(items.filter((i) => !i.read)).toHaveLength(2);
    }
  });

  it('S28 AS-59: malformed read requests are 400; foreign and unknown ids are ignored; no credentials is 401', async () => {
    const user = await t.newUser();
    const other = await t.newUser();
    const mine = await addItem(user);
    const theirs = await addItem(other);
    expect(await unreadOf(user)).toBe(1);

    const bad: unknown[] = [
      { ids: [mine], all: true },
      {},
      { ids: [] },
      { ids: Array.from({ length: 101 }, () => v4()) },
      { ids: ['not-an-id'] },
      { all: false },
      { ids: [mine], extra: 1 },
      null,
    ];
    for (const body of bad) {
      const res = await markRead(user, body).expect(400);
      expect(res.body.code).toBe('validation_failed');
    }
    expect(await unreadOf(user)).toBe(1);

    const ignored = await markRead(user, { ids: [theirs, v4()] }).expect(200);
    expect(ignored.body).toEqual({ unread: 1 });
    expect((await page(other)).items[0].read).toBe(false);
    expect(await unreadOf(other)).toBe(1);

    const dup = await markRead(user, { ids: [mine, mine] }).expect(200);
    expect(dup.body).toEqual({ unread: 0 });
    await t
      .http()
      .post('/api/notifications/read')
      .send({ all: true })
      .expect(401);
  });

  it('S28 AS-60: mark all read zeroes the count; later arrivals stay unread whatever their event time', async () => {
    const user = await t.newUser();
    for (let i = 0; i < 3; i++) await addItem(user);
    expect(await unreadOf(user)).toBe(3);

    const res = await markRead(user, { all: true }).expect(200);
    expect(unreadCountSchema.parse(res.body)).toEqual({ unread: 0 });
    const listed = (await page(user)).items;
    expect(listed).toHaveLength(3);
    expect(listed.every((i) => i.read)).toBe(true);

    t.clock.advance(1_000);
    await consume(t, [
      orderPaidEnvelope(
        { userId: user.id },
        { occurredAt: new Date(t.clock.now().getTime() - DAY) },
      ),
    ]);
    const after = (await page(user)).items;
    expect(after).toHaveLength(4);
    expect(after.filter((i) => !i.read)).toHaveLength(1);
    expect(
      after.find((i) => i.type === 'order.confirmed' && !i.read),
    ).toBeDefined();
    expect(await unreadOf(user)).toBe(1);
  });

  it('S28 AS-61: a lost counter is rebuilt from the inbox, bounded at 1,000, and counting goes on from there', async () => {
    const user = await t.newUser();
    for (let i = 0; i < 3; i++) await addItem(user);
    expect(await unreadOf(user)).toBe(3);
    await dropCounter(user);
    expect(await counter().get(user.id)).toBeNull();

    const before =
      MetricsRegistry.value('notifications_unread_rebuilt_total', {}) ?? 0;
    expect(await unreadOf(user)).toBe(3);
    expect(
      MetricsRegistry.value('notifications_unread_rebuilt_total', {}),
    ).toBe(before + 1);
    expect(await counter().get(user.id)).toBe(3);

    await consume(t, [orderPaidEnvelope({ userId: user.id })]);
    expect(await unreadOf(user)).toBe(4);

    const heavy = await t.newUser();
    const now = t.clock.now().getTime();
    for (let from = 0; from < 1_005; from += 25)
      await Promise.all(
        Array.from({ length: Math.min(25, 1_005 - from) }, (_, k) =>
          addItem(heavy, {
            eventTime: new Date(now - 60_000 - (from + k) * 1_000),
          }),
        ),
      );
    expect(await unreadOf(heavy)).toBe(1_000);
    await dropCounter(heavy);
    expect(await unreadOf(heavy)).toBe(1_000);
  });

  describe('S28 AS-62: crash between storing and counting', () => {
    it('is repaired by the reconciliation job without counting anything twice', async () => {
      const user = await t.newUser();
      expect(await unreadOf(user)).toBe(0); // the counter exists
      const event = orderPaidEnvelope({ userId: user.id });
      const crash = faultSwitch(counter(), ['increment']);
      try {
        crash.down(new Error('process died before counting'));
        await expect(consume(t, [event])).rejects.toBeDefined();
        crash.up();
        await consume(t, [event]); // the retry finds the stored item and does not count it
      } finally {
        crash.restore();
      }
      expect((await page(user)).items).toHaveLength(1);
      expect(await counter().get(user.id)).toBe(0); // stale until reconciled
      expect(
        await counter().dirtyBefore(
          new Date(t.clock.now().getTime() + DAY),
          10,
        ),
      ).toContain(user.id);

      t.clock.advance(2 * 60_000);
      const job = t.app.get(UnreadReconcileService);
      await job.reconcile();
      expect(await unreadOf(user)).toBe(1);
      expect(
        await counter().dirtyBefore(
          new Date(t.clock.now().getTime() + DAY),
          10,
        ),
      ).not.toContain(user.id);

      await job.reconcile();
      expect(await unreadOf(user)).toBe(1);
      await consume(t, [orderPaidEnvelope({ userId: user.id })]);
      expect(await unreadOf(user)).toBe(2);
    });

    it('is a periodic fleet-wide single job every 5 minutes; a schedule the platform refuses is logged, other errors fail the boot', async () => {
      const job = t.app.get(UnreadReconcileService);
      await job.onApplicationBootstrap(); // the spec's reset emptied the table the boot filled
      await job.onApplicationBootstrap(); // and a second replica registering it changes nothing
      const sequelize = t.app.get<Sequelize>(getConnectionToken(), {
        strict: false,
      });
      const rows = await sequelize.query<{ cron: string; jobType: string }>(
        `SELECT "cron","jobType" FROM "JobSchedule" WHERE "name" = 'notifications.reconcile-unread'`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toEqual([
        { cron: '0 */5 * * * *', jobType: 'notifications.reconcile-unread' },
      ]);
      expect(
        Reflect.getMetadata(
          JOB_HANDLER_METADATA,
          UnreadReconcileService.prototype.reconcile,
        ),
      ).toMatchObject({
        type: 'notifications.reconcile-unread',
        fleetConcurrency: 1,
      });

      const upsert = jest.spyOn(t.app.get(JobsService), 'upsertSchedule');
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        upsert.mockRejectedValue(new InvalidScheduleError('cron', 'bad'));
        await expect(job.onApplicationBootstrap()).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalled();
        upsert.mockRejectedValue(new Error('database down'));
        await expect(job.onApplicationBootstrap()).rejects.toThrow(
          'database down',
        );
      } finally {
        upsert.mockRestore();
        logged.mockRestore();
      }
    });
  });

  it('S28 AS-63: a realtime hub outage does not fail routing; the item is stored and counted and the failure is counted', async () => {
    const user = await t.newUser();
    expect(await unreadOf(user)).toBe(0);
    const before = realtimeFailures();
    t.realtime.down = true;

    await consume(t, [orderPaidEnvelope({ userId: user.id })]);

    expect(realtimeFailures()).toBe(before + 1);
    expect(t.realtime.to(user.id)).toHaveLength(0);
    expect((await page(user)).items).toHaveLength(1);
    expect(await unreadOf(user)).toBe(1);
    t.realtime.down = false;
  });

  it('S28 AS-64: an item 181 days old is neither listed nor counted; one 179 days old is', async () => {
    const user = await t.newUser();
    const now = t.clock.now().getTime();
    const old = await addItem(user, { eventTime: new Date(now - 181 * DAY) });
    const recent = await addItem(user, {
      eventTime: new Date(now - 179 * DAY),
    });

    const items = (await page(user)).items;
    expect(items.map((i) => i.id)).toEqual([recent]);
    expect(await unreadOf(user)).toBe(1);
    const res = await markRead(user, { ids: [old] }).expect(200);
    expect(res.body).toEqual({ unread: 1 });
  });

  it('S28 AS-65: switching in-app off for a category creates no item, count or live event, yet push follows its own cell; mandatory types still create their item', async () => {
    const user = await t.newUser();
    await port<DeviceRepository>(DEVICE_REPOSITORY).register(
      { userId: user.id, token: `tok-${v4()}`, platform: 'ios' },
      10,
      t.clock.now(),
    );
    await t
      .as(user)
      .put('/api/notifications/preferences')
      .send({ category: 'auctions', channel: 'inapp', enabled: false })
      .expect(200);
    expect(await unreadOf(user)).toBe(0);

    await consume(t, [
      envelope('auction.leader_changed', {
        auctionId: v4(),
        previousLeaderId: user.id,
        priceMinor: 5_000,
        currency: 'USD',
        auctionVersion: 2,
      }),
    ]);
    await waitFor(async () => t.providers.push.calls.length === 1, {
      description: 'the push',
    });
    expect((await page(user)).items).toHaveLength(0);
    expect(await unreadOf(user)).toBe(0);
    expect(t.realtime.to(user.id)).toHaveLength(0);

    await t
      .as(user)
      .put('/api/notifications/preferences')
      .send({ category: 'security', channel: 'inapp', enabled: false })
      .expect(200);
    await consume(t, [
      envelope('identity.mfa_disabled', { userId: user.id, reason: 'support' }),
    ]);
    const items = (await page(user)).items;
    expect(items.map((i) => i.type)).toEqual(['security.mfa_disabled']);
    expect(await unreadOf(user)).toBe(1);
  });

  it('S28 AS-66: content is in the recipient locale at creation, cut to 120 and 500 characters, with a catalog-built relative link', async () => {
    const user = await t.newUser();
    await port<SettingsRepository>(SETTINGS_REPOSITORY).update(
      user.id,
      { locale: 'uk' },
      t.clock.now(),
    );
    const event = orderPaidEnvelope({ userId: user.id });
    await consume(t, [event]);
    const [created] = (await page(user)).items;
    expect(created.title).toBe('Замовлення підтверджено');
    expect(created.link).toBe(`/orders/${event.aggregateId}`);

    await t
      .as(user)
      .put('/api/notifications/settings')
      .send({ locale: 'en' })
      .expect(200);
    const attack = `https://evil.example/x ${'z'.repeat(800)}`;
    await consume(t, [
      envelope('identity.mfa_disabled', { userId: user.id, reason: attack }),
    ]);

    const items = (await page(user)).items;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.id === created.id)).toEqual(created);
    const long = items.find((i) => i.type === 'security.mfa_disabled')!;
    expect(notificationItemSchema.parse(long)).toBeDefined();
    expect(long.body).toHaveLength(500);
    expect(long.body.endsWith('…')).toBe(true);
    expect(long.title.length).toBeLessThanOrEqual(120);
    expect(long.link).toBe('/settings/security');
    for (const item of items) {
      expect(item.link).toMatch(/^\/[^/]/);
      expect(item.link).not.toContain('://');
    }
  });
});
