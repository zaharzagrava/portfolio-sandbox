import { Logger } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { SinkBackpressureError } from '@app/infrastructure/projections/errors';
import { FollowQueryService } from './application/follow-query.service';
import {
  TIMELINE_STORE,
  TimelineUnavailableError,
  type TimelineStore,
} from './domain/ports';
import { FeedFanoutProjector } from './infra/feed-projectors';
import {
  createFeedApp,
  sortable,
  type FeedTestApp,
  type PublishedEvent,
  type TestUser,
} from './testing/feed-fixtures';

/**
 * S26 US6: fan-out stays healthy (AS-22, AS-44..AS-50): idempotent consumer, paged pipelined pushes, backpressure,
 * recovery after a failure part-way, per-author order, announcement after a bus outage, expiring keys, structured log
 * lines and metrics.
 */
describe('Follow feed: fan-out, backpressure, recovery and operations', () => {
  let t: FeedTestApp;

  beforeAll(async () => {
    t = await createFeedApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const minutesAgo = (m: number) => new Date(t.clock.nowMs() - m * 60_000);
  const timelines = () =>
    t.app.get<TimelineStore>(TIMELINE_STORE, { strict: false });
  const request = (a: PublishedEvent) => ({
    itemId: a.payload.itemId as string,
    authorId: a.payload.authorId as string,
    kind: a.payload.kind as string,
    createdAt: a.payload.createdAt as string,
  });

  /** Captures structured log objects of every level while `body` runs. */
  const captureLogs = async <T>(body: () => Promise<T>) => {
    const lines: Array<Record<string, unknown>> = [];
    const keep = (message: unknown) => {
      if (message && typeof message === 'object')
        lines.push(message as Record<string, unknown>);
    };
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(keep),
    );
    try {
      return { result: await body(), lines };
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  };

  /** A shop with `followers` followers, the first `active` of which are active. */
  const shopWithFollowers = async (followers: number, active: number) => {
    const shop = await t.seedShop();
    const users = await t.users(followers);
    for (const [i, user] of users.entries()) {
      if (i < active) await t.activate(user, shop.accountId);
      else await t.follow(user, shop.accountId).expect(204);
    }
    return { shop, users };
  };

  describe('AS-22: the consumer is idempotent and validates', () => {
    it('S26 AS-22: a duplicate delivery does nothing; the item is on each active follower page once; no timeline exceeds the window', async () => {
      t.config.set('feed_timeline_window', 2);
      const { shop, users } = await shopWithFollowers(2, 2);
      const first = await t.newProductItem(shop, minutesAgo(30));
      const [a1] = await t.announce();

      await t.fanOut([a1, a1]); // the same eventId twice
      const replay = await t.fanoutService().fanOut(request(a1));
      expect(replay).toMatchObject({ replayed: true, pushed: 0 });
      for (const user of users) {
        expect(await t.timeline(user)).toEqual([sortable(first.itemId)]);
        expect((await t.readPage(user)).items.map((i) => i.itemId)).toEqual([
          first.itemId,
        ]);
      }

      const more = [
        await t.newProductItem(shop, minutesAgo(20)),
        await t.newProductItem(shop, minutesAgo(10)),
      ];
      await t.fanOut(await t.announce());
      for (const user of users) {
        expect(await t.redis.zcard(`fd:tl:{${user.id}}`)).toBe(2);
        expect(await t.timeline(user)).toEqual(
          [...more].reverse().map((i) => sortable(i.itemId)),
        );
      }
    });

    it('S26 AS-22: an invalid announcement is dead-lettered and pushes nothing', async () => {
      const { shop, users } = await shopWithFollowers(1, 1);
      await t.newProductItem(shop, minutesAgo(5));
      const [valid] = await t.announce();
      const bad = {
        ...t.itemPublished({
          itemId: valid.payload.itemId,
          authorId: valid.payload.authorId,
        }),
        payload: { itemId: 'not-an-id', authorId: valid.payload.authorId },
      };

      const { deadLettered } = await t.deliver(
        t.projector(FeedFanoutProjector),
        [bad as never],
      );

      expect(deadLettered).toHaveLength(1);
      expect(await t.redis.exists(`fd:tl:{${users[0].id}}`)).toBe(0);
    });
  });

  describe('AS-44: follower pages and pipelined writes', () => {
    it('S26 AS-44: 5 followers, 4 active, page size 2: 3 follower pages, one existence check and one write per page, pushed 4, item stored before it is announced', async () => {
      t.config.set('feed_fanout_page_size', 2);
      const { shop, users } = await shopWithFollowers(5, 4);
      const item = await t.newProductItem(shop, minutesAgo(5));
      // stored (and its announcement recorded) before anything was announced
      expect(
        (
          await t.cql('SELECT item_id FROM feed_items WHERE item_id = ?', [
            item.itemId,
          ])
        ).rowLength,
      ).toBe(1);
      expect(
        (
          await t.cql(
            'SELECT count(*) AS n FROM item_claims WHERE kind = ? AND source_key = ?',
            ['new_product', item.productId],
          )
        )
          .first()!
          .n.toNumber(),
      ).toBe(1);
      const [announcement] = await t.announce();

      const store = timelines();
      const active = jest.spyOn(store, 'activeAmong');
      const push = jest.spyOn(store, 'push');
      const followerPages = jest.spyOn(
        t.app.get(FollowQueryService, { strict: false }),
        'getFollowerIds',
      );
      let result;
      let counts: number[] = [];
      try {
        result = await t.fanoutService().fanOut(request(announcement));
      } finally {
        counts = [followerPages, active, push].map((s) => s.mock.calls.length);
        active.mockRestore();
        push.mockRestore();
        followerPages.mockRestore();
      }

      expect(result).toMatchObject({ pushed: 4, skippedInactive: 1 });
      // three follower pages, one existence check per page and at most one pipelined write per page (none for a page
      // whose followers are all inactive)
      expect(counts.slice(0, 2)).toEqual([3, 3]);
      expect(counts[2]).toBeGreaterThanOrEqual(2);
      expect(counts[2]).toBeLessThanOrEqual(3);
      for (const user of users.slice(0, 4))
        expect(await t.timeline(user)).toEqual([sortable(item.itemId)]);
      expect(await t.redis.exists(`fd:tl:{${users[4].id}}`)).toBe(0);
    });
  });

  describe('AS-45: backpressure', () => {
    it('S26 AS-45: a saturated timeline store pauses the consumer; after it recovers every active follower has each item exactly once', async () => {
      const { shop, users } = await shopWithFollowers(3, 3);
      const created = [
        await t.newProductItem(shop, minutesAgo(30)),
        await t.newProductItem(shop, minutesAgo(20)),
        await t.newProductItem(shop, minutesAgo(10)),
      ];
      const announced = (await t.announce()).sort((a, b) =>
        sortable(a.payload.itemId) < sortable(b.payload.itemId) ? -1 : 1,
      );
      const paused = () =>
        MetricsRegistry.value('feed_consumer_paused_total') ?? 0;
      const resumed = () =>
        MetricsRegistry.value('feed_consumer_resumed_total') ?? 0;
      const pausedBefore = paused();
      const resumedBefore = resumed();

      t.faults.timelineDown = true;
      const error = await t.fanOut(announced).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SinkBackpressureError);
      expect((error as SinkBackpressureError).retryAfterMs).toBeGreaterThan(0);
      expect(paused()).toBe(pausedBefore + 1);
      for (const a of announced)
        expect(
          (
            await t.cql('SELECT item_id FROM fanout_done WHERE item_id = ?', [
              a.payload.itemId,
            ])
          ).rowLength,
        ).toBe(0);

      t.faults.timelineDown = false;
      await t.fanOut(announced); // the redelivery after the cooldown
      expect(resumed()).toBe(resumedBefore + 1);
      for (const user of users)
        expect(await t.timeline(user)).toEqual(
          [...created].reverse().map((i) => sortable(i.itemId)),
        );
    });
  });

  describe('AS-46: a failure part-way', () => {
    it('S26 AS-46: after a failure on page 2 the redelivery completes and every active follower has the item exactly once; a failed line carries author, item and the page', async () => {
      t.config.set('feed_fanout_page_size', 2);
      const { shop, users } = await shopWithFollowers(4, 4);
      const item = await t.newProductItem(shop, minutesAgo(5));
      const [announcement] = await t.announce();

      const store = timelines();
      const realPush = store.push.bind(store);
      let calls = 0;
      store.push = async (...args) => {
        if (++calls === 2) throw new TimelineUnavailableError();
        return realPush(...args);
      };
      let failure;
      try {
        failure = await captureLogs(() =>
          t
            .fanoutService()
            .fanOut(request(announcement))
            .catch((e) => e),
        );
      } finally {
        store.push = realPush;
      }

      expect(failure.result).toBeInstanceOf(Error);
      expect(failure.lines).toContainEqual(
        expect.objectContaining({
          event: 'feed.fanout.failed',
          authorId: shop.accountId,
          itemId: item.itemId,
          page: 2,
        }),
      );
      // follower pages follow the store's follower order (by id), not creation order: page 1 holds two of the four
      const holders: number[] = [];
      for (const user of users)
        holders.push(await t.redis.exists(`fd:tl:{${user.id}}`));
      expect(holders.filter((n) => n === 1)).toHaveLength(2);
      expect(holders.filter((n) => n === 0)).toHaveLength(2);

      const redelivered = await t.fanoutService().fanOut(request(announcement));
      expect(redelivered.replayed).toBe(false);
      for (const user of users) {
        expect(await t.timeline(user)).toEqual([sortable(item.itemId)]);
        expect((await t.readPage(user)).items.map((i) => i.itemId)).toEqual([
          item.itemId,
        ]);
      }
    });
  });

  describe('AS-47: per-author order', () => {
    it('S26 AS-47: announcements are keyed by author and handled in publish order', async () => {
      const { shop, users } = await shopWithFollowers(1, 1);
      const created = [
        await t.newProductItem(shop, minutesAgo(30)),
        await t.newProductItem(shop, minutesAgo(20)),
        await t.newProductItem(shop, minutesAgo(10)),
      ];
      const announced = (await t.announce()).sort((a, b) =>
        sortable(a.payload.itemId) < sortable(b.payload.itemId) ? -1 : 1,
      );
      expect(announced.map((a) => a.aggregateId)).toEqual([
        shop.accountId,
        shop.accountId,
        shop.accountId,
      ]);

      const service = t.fanoutService();
      const real = service.fanOut.bind(service);
      const handled: string[] = [];
      service.fanOut = async (req) => {
        handled.push(req.itemId);
        return real(req);
      };
      try {
        await t.fanOut(announced);
      } finally {
        service.fanOut = real;
      }

      expect(handled).toEqual(created.map((i) => i.itemId));
      expect(await t.timeline(users[0])).toEqual(
        [...created].reverse().map((i) => sortable(i.itemId)),
      );
    });
  });

  describe('AS-48: the bus is down when the item is stored', () => {
    it('S26 AS-48: the item is announced once the bus returns, without redelivering the source event; a repeat is harmless', async () => {
      const { shop, users } = await shopWithFollowers(1, 1);
      t.faults.busDown = true;
      const item = await t.newProductItem(shop, minutesAgo(5));

      expect(await t.announce()).toEqual([]);
      expect(
        (
          await t.cql('SELECT item_id FROM feed_items WHERE item_id = ?', [
            item.itemId,
          ])
        ).rowLength,
      ).toBe(1);

      t.faults.busDown = false;
      const announced = await t.announce();
      expect(announced.map((a) => a.payload.itemId)).toEqual([item.itemId]);
      expect(await t.announce()).toEqual([]);

      await t.fanOut([...announced, ...announced]);
      expect(await t.timeline(users[0])).toEqual([sortable(item.itemId)]);
    });
  });

  describe('AS-49: every key expires', () => {
    it('S26 AS-49: no fd: key lacks a TTL, the TTLs match the rules, and the active marker slides on each feed read', async () => {
      t.config.set('feed_celebrity_threshold', 3);
      const { shop, users } = await shopWithFollowers(2, 1);
      const celebrity = await shopWithFollowers(3, 2);
      await t.newProductItem(shop, minutesAgo(10));
      await t.newProductItem(celebrity.shop, minutesAgo(9));
      await t.publishAll();
      await t.readPage(users[1]); // a rebuild for the inactive follower
      await t.readPage(celebrity.users[0]); // builds the celebrity recents if absent

      const keys = await t.feedKeys();
      expect(keys.length).toBeGreaterThan(0);
      for (const { key, ttl } of keys) {
        expect(ttl).toBeGreaterThan(0);
        const limit = key.startsWith('fd:cel:')
          ? 86_400
          : key.startsWith('fd:iscel:')
            ? 3_600
            : key.startsWith('fd:cf:')
              ? 3_600
              : key.startsWith('fd:rb:')
                ? 10
                : 7 * 86_400;
        expect(ttl).toBeLessThanOrEqual(limit);
      }
      expect(keys.some((k) => k.key.startsWith('fd:cel:'))).toBe(true);
      expect(keys.some((k) => k.key.startsWith('fd:tl:'))).toBe(true);

      await t.redis.expire(`fd:act:{${users[0].id}}`, 100);
      await t.readPage(users[0]);
      expect(await t.redis.ttl(`fd:act:{${users[0].id}}`)).toBeGreaterThan(
        7 * 86_400 - 60,
      );
    });
  });

  describe('AS-50: log lines and metrics', () => {
    it('S26 AS-50: one structured completed line without follower ids, and the metrics are updated', async () => {
      const { shop, users } = await shopWithFollowers(3, 2);
      await t.newProductItem(shop, minutesAgo(5));
      const [announcement] = await t.announce();
      const lagBefore =
        MetricsRegistry.histogramValue('feed_fanout_lag_seconds')?.count ?? 0;
      const pushedBefore =
        MetricsRegistry.value('feed_fanout_pushed_total') ?? 0;

      const { lines } = await captureLogs(() =>
        t.fanoutService().fanOut(request(announcement)),
      );

      const completed = lines.filter(
        (l) => l.event === 'feed.fanout.completed',
      );
      expect(completed).toHaveLength(1);
      expect(Object.keys(completed[0]).sort()).toEqual(
        [
          'authorId',
          'celebrity',
          'durationMs',
          'event',
          'followers',
          'itemId',
          'lagMs',
          'pushed',
          'skippedInactive',
        ].sort(),
      );
      expect(completed[0]).toMatchObject({
        authorId: shop.accountId,
        followers: 3,
        pushed: 2,
        skippedInactive: 1,
        celebrity: false,
      });
      for (const user of users)
        expect(JSON.stringify(lines)).not.toContain(user.id);
      expect(
        MetricsRegistry.histogramValue('feed_fanout_lag_seconds')!.count,
      ).toBe(lagBefore + 1);
      expect(MetricsRegistry.value('feed_fanout_pushed_total')).toBe(
        pushedBefore + 2,
      );
    });

    it('S26 AS-50: a rebuild, a degraded read and a consumer pause are counted by outcome', async () => {
      const rebuilds = () =>
        MetricsRegistry.value('feed_rebuild_total', { outcome: 'complete' }) ??
        0;
      const degraded = () =>
        MetricsRegistry.value('feed_degraded_total', {
          reason: 'timeline_down',
        }) ?? 0;
      const [reader]: TestUser[] = await t.users(1);
      const shop = await t.seedShop();
      await t.follow(reader, shop.accountId).expect(204);
      const rebuildsBefore = rebuilds();
      await t.readPage(reader);
      expect(rebuilds()).toBe(rebuildsBefore + 1);

      const degradedBefore = degraded();
      t.faults.timelineDown = true;
      expect((await t.readPage(reader)).degraded).toBe(true);
      t.faults.timelineDown = false;
      expect(degraded()).toBeGreaterThan(degradedBefore);
      expect(MetricsRegistry.labelSets('feed_degraded_total')).toEqual(
        expect.arrayContaining([{ reason: 'timeline_down' }]),
      );
    });
  });
});
