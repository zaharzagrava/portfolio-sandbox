import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  recommendationsResponseSchema,
  trendingResponseSchema,
  type FeedItemView,
} from '@marketplace-sandbox/contracts';
import { waitFor } from '../utils/async-helpers';
import { adminClient, ControlSurface } from './support/control-surface';
import { engagementFixture as fx, FRONT } from './support/engagement-fixture';
import { eventTap, tapUntil } from './support/event-tap';
import { itemsOf, unreadCount, waitForItems } from './support/inbox';
import { JourneyClient, problemCode, unique } from './support/journey-client';
import { openStream } from './support/stream';
import { apiLogPath, logLinesSince, logMark } from './support/observability';
import {
  createSeller,
  type FixtureProduct,
  type SellerFixture,
} from './support/seller-fixture';
import {
  getOrder,
  payOrder,
  waitOrderStatus,
  waitPaymentStatus,
} from './support/purchase';
import {
  storefrontDouble,
  visitorId,
  type StorefrontEvent,
} from './support/storefront-double';
import { staysTrue, waitForContract } from './support/wait-for-contract';

/**
 * Journey J05: engagement loop. Black box: public HTTP, SSE, the control surface and the read-only event tap only; every
 * story creates its own users, shops and products (L-005, L-006); every wait is a contract hop `J05.H1..H16`, never a sleep
 * (L-007). Scenario titles carry the test-plan id (L-017): `J05 AS-nn`.
 */
describe('Journey J05: engagement loop', () => {
  let admin: JourneyClient;
  let control: ControlSurface;
  /** Where this run starts in the API log (L-032). */
  let logStart = 0;
  const runLog = apiLogPath();
  /** The first instant of the run: replays start here so they cover this run only. */
  const journeyStart = new Date();

  beforeAll(async () => {
    admin = await adminClient();
    control = new ControlSurface(admin);
    await control.restoreAll(); // a known stack: consumers running, clock real
    logStart = logMark(runLog);
  });

  afterAll(async () => {
    await control?.restoreAll({ endAdminSessions: true });
  });

  const accountOf = (seller: SellerFixture) => `shop:${seller.shopId}`;
  const itemsOfKind = (items: FeedItemView[], kind: FeedItemView['kind']) =>
    items.filter((i) => i.kind === kind);
  const newProductItems = (items: FeedItemView[], productId: string) =>
    items.filter(
      (i) => i.kind === 'new_product' && i.payload.productId === productId,
    );
  /** Product version for an `expectedVersion` write. */
  const versionOf = async (seller: SellerFixture, productId: string) =>
    (
      await seller.owner.get<{ version: number }>(
        `/api/shops/${seller.shopId}/products/${productId}`,
      )
    ).body.version;
  const archive = (seller: SellerFixture, productId: string) =>
    versionOf(seller, productId).then((expectedVersion) =>
      seller.owner.post(
        `/api/shops/${seller.shopId}/products/${productId}/archive`,
        { body: { expectedVersion } },
      ),
    );
  const restore = (seller: SellerFixture, productId: string) =>
    versionOf(seller, productId).then((expectedVersion) =>
      seller.owner.post(
        `/api/shops/${seller.shopId}/products/${productId}/restore`,
        { body: { expectedVersion } },
      ),
    );
  /** Gives every spec a settled consumer before it asserts an absence (L-003). */
  const settled = async (...groups: string[]) => {
    for (const group of groups) await control.waitCaughtUp(group, 'J05.H15');
  };
  /**
   * Trending commits only up to its oldest open window, and a window closes at its end + lateness (120 s) once the partition
   * has been silent for the idle time (30 s) on the stack clock. A batch that the consumer reads after a clock move restarts
   * that silence, so the clock is moved again every few seconds until the group has caught up.
   */
  const settledByClock = async (group: string) => {
    let lastMove = 0;
    let moves = 0;
    await waitForContract(
      'J05.H15',
      async () => {
        const view = await control.consumer(group);
        if (view.state === 'RUNNING' && view.lag === 0) return view;
        if (Date.now() - lastMove > 3_000) {
          lastMove = Date.now();
          // the first move clears the windows (end + lateness + idle); the later ones only outlast the idle time
          await control.advance(moves++ === 0 ? 300 : 40);
        }
        return null;
      },
      `consumer ${group} caught up, its windows closed by the clock`,
    );
  };

  // ------------------------------------------------------------------------------------------------------------------
  describe('US1: a follower sees the shop’s new product in their feed', () => {
    let seller: SellerFixture;
    let b: JourneyClient;
    let x: JourneyClient;
    let p: FixtureProduct;
    let itemId: string;

    beforeAll(async () => {
      seller = await createSeller(admin, {
        products: [{ priceMinor: 2000, quantity: 20 }],
      });
      [b, x] = await Promise.all([
        JourneyClient.signUp('follower'),
        JourneyClient.signUp('stranger'),
      ]);
    });

    it('J05 AS-01: a follower reads the shop’s new product once, a stranger does not, and the feed announces it once', async () => {
      expect(await fx.follow(b, accountOf(seller))).toBe(204);
      expect(await fx.followStatus(b, [accountOf(seller)])).toEqual([
        { accountId: accountOf(seller), following: true, followerCount: 1 },
      ]);
      const following = await b.get<{ items: { accountId: string }[] }>(
        '/api/me/following',
      );
      expect(following.body.items.map((i) => i.accountId)).toContain(
        accountOf(seller),
      );
      expect(await fx.feed(b)).toEqual([]); // this read marks B active

      p = await fx.publishProduct(seller, { priceMinor: 2000 });
      const items = await fx.feedUntil(
        'J05.H2',
        b,
        (found) => newProductItems(found, p.id).length >= 1,
        `new_product ${p.id} in the feed of B`,
      );
      const mine = newProductItems(items, p.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        kind: 'new_product',
        author: { accountId: accountOf(seller), type: 'shop' },
        title: p.title,
        payload: { productId: p.id, priceMinor: 2000, currency: 'EUR' },
      });
      itemId = mine[0].itemId;

      expect(newProductItems(await fx.feed(x), p.id)).toEqual([]);
      await settled('community-feed-fanout');
      const announced = await tapUntil(
        'J05.H2',
        'feed.events',
        { type: 'feed.item_published', key: accountOf(seller) },
        1,
      );
      expect(
        announced.filter(
          (m) => (m.payload as { itemId?: string })?.itemId === itemId,
        ),
      ).toHaveLength(1);
    });

    it('J05 AS-02: a follower who follows after the product exists reads it once on the first read', async () => {
      const c1 = await JourneyClient.signUp('late-follower');
      expect(await fx.follow(c1, accountOf(seller))).toBe(204);
      const first = await fx.feed(c1);
      expect(newProductItems(first, p.id)).toHaveLength(1);
    });

    it('J05 AS-03: replaying the product and feed events changes nothing', async () => {
      const before = await fx.feed(b);
      const status = await fx.followStatus(b, [accountOf(seller)]);
      const announcements = async () =>
        (
          await eventTap('feed.events', {
            type: 'feed.item_published',
            key: accountOf(seller),
          })
        ).map((m) => m.eventId);
      const announcedBefore = await announcements();

      await control.replay('community-feed-products', journeyStart);
      await control.replay('community-feed-fanout', journeyStart);
      await settled('community-feed-products', 'community-feed-fanout');

      expect((await fx.feed(b)).map((i) => i.itemId)).toEqual(
        before.map((i) => i.itemId),
      );
      expect(await fx.followStatus(b, [accountOf(seller)])).toEqual(status);
      expect(await announcements()).toEqual(announcedBefore);
    });

    it('J05 AS-04: an archived product leaves the feed, an old event cannot bring it back, a restore shows it again once', async () => {
      expect((await archive(seller, p.id)).status).toBe(200);
      await fx.feedUntil(
        'J05.H3',
        b,
        (items) => newProductItems(items, p.id).length === 0,
        `${p.id} hidden from the feed`,
      );

      await control.replay('community-feed-products', journeyStart);
      await settled('community-feed-products', 'community-feed-fanout');
      expect(newProductItems(await fx.feed(b), p.id)).toHaveLength(0);

      expect((await restore(seller, p.id)).status).toBe(200);
      const back = await fx.feedUntil(
        'J05.H3',
        b,
        (items) => newProductItems(items, p.id).length >= 1,
        `${p.id} visible again`,
      );
      expect(newProductItems(back, p.id)).toHaveLength(1);
    });

    it('J05 AS-05: with the fan-out consumer down the seller is not blocked; after resuming the feed holds the product once', async () => {
      // A reader whose pushed timeline already holds more than the page asked for is served by the push alone (a shorter
      // timeline is completed from the author's history, which no consumer pause can hold back).
      await fx.publishProduct(seller, { priceMinor: 2100 });
      await fx.publishProduct(seller, { priceMinor: 2200 });
      const w = await JourneyClient.signUp('active-follower');
      expect(await fx.follow(w, accountOf(seller))).toBe(204);
      await fx.feedUntil(
        'J05.H2',
        w,
        (items) => itemsOfKind(items, 'new_product').length >= 3,
        'the earlier products in the feed of W',
      );

      await control.pause('community-feed-fanout');
      const started = Date.now();
      const p2 = await fx.publishProduct(seller, { priceMinor: 2500 });
      expect(Date.now() - started).toBeLessThan(10_000);

      await waitFor(
        async () => (await control.lag('community-feed-fanout')) >= 1,
        {
          timeoutMs: 20_000,
          intervalMs: 250,
          description: 'lag of community-feed-fanout >= 1',
        },
      );
      await staysTrue(
        'J05.H2',
        async () => {
          const top = await fx.feedPage(w, 1);
          if (
            top.some(
              (i) => i.kind === 'new_product' && i.payload.productId === p2.id,
            )
          )
            throw new Error(
              'P2 reached the pushed timeline while fan-out was paused',
            );
        },
        'P2 absent from the pushed timeline while the fan-out consumer is paused',
      );

      await control.resume('community-feed-fanout');
      await control.waitCaughtUp('community-feed-fanout', 'J05.H15');
      const items = await waitForContract(
        'J05.H2',
        async () => {
          const top = await fx.feedPage(w, 1);
          return top.some(
            (i) => i.kind === 'new_product' && i.payload.productId === p2.id,
          )
            ? await fx.feed(w)
            : null;
        },
        `${p2.id} newest in the feed after resume`,
      );
      expect(newProductItems(items, p2.id)).toHaveLength(1);
    });

    it('J05 AS-06: a price drop makes one price_drop item and a second drop inside 24 hours makes none', async () => {
      const p3 = await fx.publishProduct(seller, { priceMinor: 2000 });
      await fx.feedUntil(
        'J05.H2',
        b,
        (items) => newProductItems(items, p3.id).length >= 1,
        `${p3.id} listed`,
      );
      const drop = async (priceMinor: number) => {
        const expectedVersion = await versionOf(seller, p3.id);
        const reply = await seller.owner.call(
          'PATCH',
          `/api/shops/${seller.shopId}/products/${p3.id}`,
          { body: { expectedVersion, priceMinor } },
        );
        expect(reply.status).toBe(200);
      };
      const drops = (items: FeedItemView[]) =>
        itemsOfKind(items, 'price_drop').filter(
          (i) => (i.payload as { productId?: string }).productId === p3.id,
        );

      await drop(1500);
      const first = await fx.feedUntil(
        'J05.H3',
        b,
        (items) => drops(items).length >= 1,
        'price_drop item',
      );
      expect(drops(first)).toHaveLength(1);
      expect(drops(first)[0].payload).toMatchObject({
        previousPriceMinor: 2000,
        priceMinor: 1500,
      });

      await drop(1200);
      await settled('community-feed-products', 'community-feed-fanout');
      expect(drops(await fx.feed(b))).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe('US2: a discussion, the post in the feed, the comment notice', () => {
    let seller: SellerFixture;
    let p: FixtureProduct;
    let b: JourneyClient;
    let w: JourneyClient;
    let postId: string;
    const postKey = `k-j05-${randomUUID().slice(0, 8)}`;
    const postBody = {
      title: 'Does the blue one fit small wrists?',
      body: 'Asking before I buy.',
    };
    const postItems = (items: FeedItemView[], id: string) =>
      items.filter((i) => i.kind === 'post' && i.payload.postId === id);

    beforeAll(async () => {
      seller = await createSeller(admin, {
        products: [{ priceMinor: 2000, quantity: 20 }],
      });
      p = seller.products[0];
      [b, w] = await Promise.all([
        JourneyClient.signUp('poster'),
        JourneyClient.signUp('post-follower'),
      ]);
      expect(await fx.follow(w, `user:${b.userId}`)).toBe(204);
      await fx.feed(w); // marks W active
    });

    it('J05 AS-07: a post reaches the followers\u2019 feed once and heads the board list; a stranger sees nothing', async () => {
      const created = await fx.post(b, p.id, postKey, postBody);
      expect(created.status).toBe(201);
      postId = created.body.postId;

      const items = await fx.feedUntil(
        'J05.H4',
        w,
        (found) => postItems(found, postId).length >= 1,
        `post ${postId} in the feed of W`,
      );
      expect(postItems(items, postId)).toHaveLength(1);
      expect(postItems(items, postId)[0]).toMatchObject({
        kind: 'post',
        author: { accountId: `user:${b.userId}`, type: 'user' },
        title: postBody.title,
        payload: { postId, boardId: p.id },
      });

      const stranger = await JourneyClient.signUp('post-stranger');
      expect(postItems(await fx.feed(stranger), postId)).toEqual([]);

      const board = await fetch(
        `${process.env.API_URL ?? 'http://localhost:8000'}/api/boards/${p.id}/posts?sort=new`,
      );
      expect(board.status).toBe(200);
      const page = (await board.json()) as { items: { postId: string }[] };
      expect(page.items[0].postId).toBe(postId);
    });

    it('J05 AS-08: a post retried five times at once and again gives one post, one feed item, and a changed body is refused', async () => {
      const key = `k-j05-${randomUUID().slice(0, 8)}`;
      const body = {
        title: 'Retried question about shipping',
        body: 'Same body.',
      };
      const answers = await Promise.all(
        Array.from({ length: 5 }, () => fx.post(b, p.id, key, body)),
      );
      // while the first request is still running the others are told to come back (409 idempotency_in_flight); none creates a second post
      for (const answer of answers) {
        if (answer.status === 409)
          expect(problemCode(answer.body)).toBe('idempotency_in_flight');
        else expect(answer.status).toBe(201);
      }
      expect(
        answers.filter((a) => a.status === 201).length,
      ).toBeGreaterThanOrEqual(1);
      const again = await fx.post(b, p.id, key, body);
      expect(again.status).toBe(201);
      const ids = new Set(
        [...answers, again]
          .filter((a) => a.status === 201)
          .map((a) => a.body.postId),
      );
      expect(ids.size).toBe(1);
      const retried = [...ids][0];

      const items = await fx.feedUntil(
        'J05.H4',
        w,
        (found) => postItems(found, retried).length >= 1,
        `retried post ${retried}`,
      );
      expect(postItems(items, retried)).toHaveLength(1);
      await settled('community-feed-discussions');
      expect(postItems(await fx.feed(w), retried)).toHaveLength(1);

      const changed = await fx.post(b, p.id, key, {
        ...body,
        title: 'A different title entirely',
      });
      expect(changed.status).toBe(422);
      expect(problemCode(changed.body)).toBe('idempotency_key_reuse');
      const keyless = await b.post(`/api/boards/${p.id}/posts`, { body });
      expect(keyless.status).toBe(422);
      expect(problemCode(keyless.body)).toBe('idempotency_key_required');
    });

    it('J05 AS-09: the seller\u2019s answer notifies the post\u2019s author once, over the inbox, the unread count and the stream; nobody else', async () => {
      const stream = await openStream(b, `user:${b.userId}`);
      try {
        const before = await unreadCount(b);
        const answered = await fx.comment(
          seller.owner,
          postId,
          undefined,
          'Yes: the strap is adjustable down to 14 cm.',
        );
        expect(answered.status).toBe(201);

        const [notice] = await waitForItems('J05.H6', b, 'discussion.comment');
        expect(notice).toMatchObject({
          type: 'discussion.comment',
          category: 'discussions',
          read: false,
        });
        expect(`${notice.title} ${notice.body}`).toContain('adjustable');
        expect(await unreadCount(b)).toBe(before + 1);
        await stream.next(
          (e) => e.event === 'notification',
          15_000,
          'a notification for the post author',
        );
        expect(
          stream.events.filter((e) => e.event === 'notification'),
        ).toHaveLength(1);

        await settled('notification-router');
        expect(await itemsOf(b, 'discussion.comment')).toHaveLength(1);
        expect(await itemsOf(seller.owner, 'discussion.comment')).toHaveLength(
          0,
        );
        expect(await itemsOf(w, 'discussion.comment')).toHaveLength(0);
      } finally {
        stream.close();
      }
    });

    it('J05 AS-10: a deleted post leaves the followers\u2019 feed at once and the old event cannot bring it back', async () => {
      const gone = await b.call('DELETE', `/api/posts/${postId}`);
      expect(gone.status).toBe(204);
      // no polling: the very next read omits it
      expect(postItems(await fx.feed(w), postId)).toEqual([]);
      expect((await b.get(`/api/posts/${postId}`)).status).toBe(404);

      const deleted = await tapUntil('J05.H4', 'discussion.events', {
        type: 'discussion.post_deleted',
        key: postId,
      });
      expect(deleted).toHaveLength(1);

      await control.replay('community-feed-discussions', journeyStart);
      await settled('community-feed-discussions', 'community-feed-fanout');
      expect(postItems(await fx.feed(w), postId)).toEqual([]);
    });

    it('J05 AS-11: with the discussion consumer down the post exists at once and reaches the feed once after resuming', async () => {
      await control.pause('community-feed-discussions');
      const created = await fx.post(b, p.id, undefined, {
        title: 'A question while the feed consumer sleeps',
        body: 'Anyone?',
      });
      expect(created.status).toBe(201);
      const id = created.body.postId;
      expect((await b.get(`/api/posts/${id}`)).status).toBe(200);

      await waitFor(
        async () => (await control.lag('community-feed-discussions')) >= 1,
        {
          timeoutMs: 20_000,
          intervalMs: 250,
          description: 'lag of community-feed-discussions >= 1',
        },
      );
      await staysTrue(
        'J05.H4',
        async () => {
          if (postItems(await fx.feed(w), id).length > 0)
            throw new Error(
              'the post reached the feed while its consumer was paused',
            );
        },
        'the post is absent while community-feed-discussions is paused',
      );

      await control.resume('community-feed-discussions');
      await control.waitCaughtUp('community-feed-discussions', 'J05.H15');
      const items = await fx.feedUntil(
        'J05.H4',
        w,
        (found) => postItems(found, id).length >= 1,
        `post ${id} after resume`,
      );
      expect(postItems(items, id)).toHaveLength(1);
    });

    it('J05 AS-12: a board exists only for a product: an unknown product answers 404 board_not_found and publishes nothing', async () => {
      const unknown = randomUUID();
      const before = await fx.feed(w);
      const refused = await fx.post(b, unknown);
      expect(refused.status).toBe(404);
      expect(problemCode(refused.body)).toBe('board_not_found');

      await settled('community-feed-discussions');
      const created = await eventTap('discussion.events', {
        type: 'discussion.post_created',
      });
      expect(
        created.filter(
          (m) => (m.payload as { boardId?: string })?.boardId === unknown,
        ),
      ).toEqual([]);
      expect((await fx.feed(w)).map((i) => i.itemId)).toEqual(
        before.map((i) => i.itemId),
      );
    });
  });
  // ------------------------------------------------------------------------------------------------------------------
  describe('US3: a friend buys through the buyer’s short link and the buyer is credited once', () => {
    const GROUP = 'marketing-affiliate-conversions';
    let seller: SellerFixture;
    let P: FixtureProduct;
    let Q: FixtureProduct;
    let b: JourneyClient;
    let f: JourneyClient;
    let c1: JourneyClient;
    let code: string;
    let of: { orderId: string; totalMinor: number };
    let ofConversionId = '';

    const lines = () => [
      { product: P, quantity: 1 },
      { product: Q, quantity: 1 },
    ];
    const converted = (linkCode = code) =>
      eventTap('links.events', { type: 'link.converted', key: linkCode });
    const reversed = (linkCode = code) =>
      eventTap('links.events', {
        type: 'link.conversion_reversed',
        key: linkCode,
      });
    /** The `link.converted` events once `n` are on the tap and the consumer has caught up (so a late duplicate shows). */
    const announcedConversions = async (n: number, linkCode = code) => {
      await tapUntil(
        'J05.H9',
        'links.events',
        { type: 'link.converted', key: linkCode },
        n,
      );
      await settled(GROUP);
      return converted(linkCode);
    };
    const waitConversions = (n: number, linkCode = code) =>
      waitForContract(
        'J05.H9',
        async () => {
          const found = await fx.conversions(b, linkCode);
          return found.length >= n ? found : null;
        },
        `${n} conversion(s) of ${linkCode}`,
      );
    const waitClicks = (n: number, linkCode = code) =>
      waitForContract(
        'J05.H7',
        async () => {
          const stats = await fx.stats(b, linkCode);
          return stats.total >= n ? stats : null;
        },
        `${n} click(s) of ${linkCode}`,
      );
    const idOf = (m: { payload: unknown }) =>
      (m.payload as { conversionId?: string }).conversionId;

    beforeAll(async () => {
      seller = await createSeller(admin, {
        products: [
          { priceMinor: 2000, quantity: 60 },
          { priceMinor: 1500, quantity: 60 },
        ],
      });
      [P, Q] = seller.products;
      [b, f, c1] = await Promise.all([
        JourneyClient.signUp('sharer'),
        JourneyClient.signUp('friend'),
        JourneyClient.signUp('clicker'),
      ]);
    });

    it('J05 AS-13: a link, a click, a referred checkout and a payment give the sharer exactly one conversion, without the buyer', async () => {
      const created = await fx.createLink(
        b,
        P.id,
        `k-j05-${randomUUID().slice(0, 8)}`,
      );
      expect(created.status).toBe(201);
      code = created.body.code;
      const click = await fx.click(code);
      expect(click.status).toBe(302);
      expect(click.ref).toBe(code);
      expect((await waitClicks(1)).total).toBe(1);

      const placed = await fx.referredCheckout(f, lines(), { ref: code });
      expect(placed.status).toBe(202);
      expect(placed.body).toMatchObject({ status: 'RESERVED' });
      of = { orderId: placed.body.orderId, totalMinor: placed.body.totalMinor };
      const order = await waitForContract(
        'J05.H8',
        async () => {
          const o = await getOrder(f, of.orderId);
          return o.attribution ? o : null;
        },
        `attribution on ${of.orderId}`,
      );
      expect(order.attribution).toEqual({ code });
      expect(JSON.stringify(order)).not.toContain(b.userId);

      expect((await payOrder(f, of.orderId)).status).toBe(202);
      await waitOrderStatus(f, of.orderId, 'PAID', 'H3');

      const [conversion] = await waitConversions(1);
      ofConversionId = conversion.conversionId;
      expect(await fx.conversions(b, code)).toHaveLength(1);
      expect(conversion).toMatchObject({
        amountMinor: of.totalMinor,
        currency: 'EUR',
        status: 'CONFIRMED',
        refundedMinor: 0,
      });
      const stats = await fx.stats(b, code);
      expect(stats).toMatchObject({
        conversions: 1,
        convertedMinor: of.totalMinor,
      });
      const tap = await announcedConversions(1);
      expect(tap).toHaveLength(1);
      expect(tap[0].payload).toMatchObject({
        conversionId: conversion.conversionId,
        linkCode: code,
        amountMinor: of.totalMinor,
        currency: 'EUR',
      });

      const stranger = await JourneyClient.signUp('link-stranger');
      for (const path of [
        `/api/links/${code}/conversions`,
        `/api/links/${code}/stats`,
      ]) {
        const refused = await stranger.get(path);
        expect(refused.status).toBe(404);
        expect(problemCode(refused.body)).toBe('link_not_found');
      }
      expect(
        JSON.stringify([conversion, stats, tap.map((m) => m.payload)]),
      ).not.toContain(f.userId);
    });

    it('J05 AS-14: five checkouts with one key give one order and one conversion; another ref under the key is refused', async () => {
      const key = `k-j05-${randomUUID().slice(0, 8)}`;
      for (const line of lines())
        expect(
          (
            await f.put(`/api/cart/items/${line.product.id}`, {
              body: { quantity: 1 },
            })
          ).status,
        ).toBeLessThan(300);
      const answers = await Promise.all(
        Array.from({ length: 5 }, () =>
          f.post('/api/checkout', { key, body: { ref: code } }),
        ),
      );
      for (const answer of answers) {
        if (answer.status === 409)
          expect(problemCode(answer.body)).toBe('idempotency_in_flight');
        else expect(answer.status).toBe(202);
      }
      const again = await f.post('/api/checkout', { key, body: { ref: code } });
      expect(again.status).toBe(202);
      const ids = new Set(
        [...answers, again]
          .filter((a) => a.status === 202)
          .map((a) => (a.body as { orderId: string }).orderId),
      );
      expect(ids.size).toBe(1);
      const orderId = [...ids][0];

      const other = await f.post('/api/checkout', {
        key,
        body: { ref: 'another-code' },
      });
      expect(other.status).toBe(422);
      expect(problemCode(other.body)).toBe('idempotency_key_reuse');

      expect((await getOrder(f, orderId)).attribution).toEqual({ code });
      expect((await payOrder(f, orderId)).status).toBe(202);
      await waitOrderStatus(f, orderId, 'PAID', 'H3');
      await waitConversions(2);
      await settled(GROUP);
      expect(await fx.conversions(b, code)).toHaveLength(2);
      expect(await announcedConversions(2)).toHaveLength(2);
    });

    it('J05 AS-15: with the conversion consumer down the order is paid at once and the credit follows once; a replay changes nothing', async () => {
      await control.pause(GROUP);
      try {
        const paid = await fx.buy(f, lines(), { ref: code });
        expect(paid.orderId).toBeTruthy();
        expect(await control.lag(GROUP)).toBeGreaterThanOrEqual(1);
        expect(await fx.conversions(b, code)).toHaveLength(2);
      } finally {
        await control.resume(GROUP);
      }
      await waitConversions(3);
      await settled(GROUP);
      const before = await fx.conversions(b, code);
      const statsBefore = await fx.stats(b, code);
      expect(await announcedConversions(3)).toHaveLength(3);

      await control.replay(GROUP, journeyStart);
      await settled(GROUP);
      expect(await fx.conversions(b, code)).toEqual(before);
      const statsAfter = await fx.stats(b, code);
      expect(statsAfter.conversions).toBe(statsBefore.conversions);
      expect(statsAfter.convertedMinor).toBe(statsBefore.convertedMinor);
      expect(await converted()).toHaveLength(3);
    });

    it('J05 AS-16: the sharer buying through their own link is accepted and not credited', async () => {
      const before = (await fx.conversions(b, code)).length;
      const paid = await fx.buy(b, [{ product: P, quantity: 1 }], {
        ref: code,
      });
      expect((await getOrder(b, paid.orderId)).attribution).toBeNull();
      await settled(GROUP);
      expect(await fx.conversions(b, code)).toHaveLength(before);
      expect(await converted()).toHaveLength(before);
    });

    it('J05 AS-17: an unknown or disabled reference never blocks a purchase and is never credited; a malformed one is refused; an expired link still credits', async () => {
      const before = (await fx.conversions(b, code)).length;
      const unknown = await fx.referredCheckout(
        f,
        [{ product: P, quantity: 1 }],
        { ref: 'zzzzzzz' },
      );
      expect(unknown.status).toBe(202);
      expect((await getOrder(f, unknown.body.orderId)).attribution).toBeNull();
      expect((await payOrder(f, unknown.body.orderId)).status).toBe(202);
      await waitOrderStatus(f, unknown.body.orderId, 'PAID', 'H3');

      // a ref of the wrong shape is a validation error, not a silent miss (S10.R-47)
      const malformed = await f.post('/api/checkout', {
        key: randomUUID(),
        body: { ref: 'not a code!' },
      });
      expect(malformed.status).toBe(400);

      const disabledLink = await fx.linkOf(b, Q.id);
      expect((await fx.click(disabledLink.code)).status).toBe(302);
      const off = await b.post(`/api/links/${disabledLink.code}/disable`, {
        key: randomUUID(),
      });
      expect(off.status).toBeLessThan(300);
      const viaDisabled = await fx.referredCheckout(
        f,
        [{ product: P, quantity: 1 }],
        { ref: disabledLink.code },
      );
      expect(viaDisabled.status).toBe(202);
      expect(
        (await getOrder(f, viaDisabled.body.orderId)).attribution,
      ).toBeNull();
      expect((await payOrder(f, viaDisabled.body.orderId)).status).toBe(202);
      await waitOrderStatus(f, viaDisabled.body.orderId, 'PAID', 'H3');
      await settled(GROUP);
      expect(await fx.conversions(b, code)).toHaveLength(before);
      expect(await fx.conversions(b, disabledLink.code)).toEqual([]);

      const expiring = await fx.createLink(b, Q.id, undefined, { ttlDays: 1 });
      expect(expiring.status).toBe(201);
      const expiringCode = expiring.body.code as string;
      expect((await fx.click(expiringCode)).status).toBe(302);
      try {
        await control.advance(25 * 3600);
        const placed = await fx.referredCheckout(
          f,
          [{ product: P, quantity: 1 }],
          { ref: expiringCode },
        );
        expect(placed.status).toBe(202);
        expect((await getOrder(f, placed.body.orderId)).attribution).toEqual({
          code: expiringCode,
        });
        expect((await payOrder(f, placed.body.orderId)).status).toBe(202);
        await waitOrderStatus(f, placed.body.orderId, 'PAID', 'H3');
        expect(await waitConversions(1, expiringCode)).toHaveLength(1);
      } finally {
        await control.reset();
      }
    });

    it('J05 AS-18: a click alone does not credit; a buyer without a ref is not attributed', async () => {
      const clicksBefore = (await fx.stats(b, code)).total;
      const before = (await fx.conversions(b, code)).length;
      expect((await fx.click(code)).status).toBe(302);
      const paid = await fx.buy(c1, [{ product: P, quantity: 1 }]);
      expect((await getOrder(c1, paid.orderId)).attribution).toBeNull();
      expect((await waitClicks(clicksBefore + 1)).total).toBe(clicksBefore + 1);
      await settled(GROUP);
      expect(await fx.conversions(b, code)).toHaveLength(before);
    });

    it('J05 AS-19: a full refund reverses the credit once and the statistics drop it', async () => {
      const first = (await fx.conversions(b, code)).find(
        (c) => c.conversionId === ofConversionId && c.status === 'CONFIRMED',
      );
      if (!first)
        throw new Error('the conversion of the first order is missing');
      const statsBefore = await fx.stats(b, code);
      const refundOnce = async () =>
        fx.refundWebhook(
          of.orderId,
          of.totalMinor,
          of.totalMinor,
          new Date((await control.clock()).now).getTime(),
        );
      expect(await refundOnce()).toBe(200);
      await waitForContract(
        'J05.H10',
        async () =>
          (await fx.conversions(b, code)).find(
            (c) =>
              c.conversionId === first.conversionId && c.status === 'REVERSED',
          ) ?? null,
        `conversion ${first.conversionId} REVERSED`,
      );
      // the provider repeats itself
      expect(await refundOnce()).toBe(200);
      await settled(GROUP);

      const after = (await fx.conversions(b, code)).find(
        (c) => c.conversionId === first.conversionId,
      );
      expect(after).toMatchObject({
        status: 'REVERSED',
        refundedMinor: first.amountMinor,
      });
      const statsAfter = await fx.stats(b, code);
      expect(statsAfter.conversions).toBe(statsBefore.conversions - 1);
      expect(statsAfter.convertedMinor).toBe(
        statsBefore.convertedMinor - of.totalMinor,
      );
      await tapUntil('J05.H10', 'links.events', {
        type: 'link.conversion_reversed',
        key: code,
      });
      expect(
        (await reversed()).filter((m) => idOf(m) === first.conversionId),
      ).toHaveLength(1);
      expect(
        (await converted()).filter((m) => idOf(m) === first.conversionId),
      ).toHaveLength(1);
    });

    it('J05 AS-20: a declined or expired attributed order never credits', async () => {
      const before = (await fx.conversions(b, code)).length;
      const announced = (await converted()).length;
      const declined = await fx.referredCheckout(
        f,
        [{ product: P, quantity: 1 }],
        { ref: code },
      );
      expect(declined.status).toBe(202);
      const accepted = await payOrder(
        f,
        declined.body.orderId,
        'pm_test_declined',
      );
      await waitPaymentStatus(
        f,
        (accepted.body as { paymentId: string }).paymentId,
        'FAILED',
        'H2',
      );
      await waitOrderStatus(f, declined.body.orderId, 'CANCELLED', 'H11');

      const held = await fx.referredCheckout(f, [{ product: P, quantity: 1 }], {
        ref: code,
      });
      expect(held.status).toBe(202);
      try {
        await control.advance(16 * 60); // the hold lasts 15 minutes
        await waitOrderStatus(f, held.body.orderId, 'CANCELLED', 'H11');
      } finally {
        await control.reset();
      }
      await settled(GROUP);
      expect(await fx.conversions(b, code)).toHaveLength(before);
      expect(await converted()).toHaveLength(announced);
    });

    it('J05 AS-21: a link is created once per key; a destination outside the marketplace is refused', async () => {
      const key = `k-j05-${randomUUID().slice(0, 8)}`;
      const destination = `${FRONT}/products/${Q.id}?utm=five`;
      const answers = await Promise.all(
        Array.from({ length: 5 }, () =>
          fx.createLink(b, Q.id, key, { destination }),
        ),
      );
      for (const answer of answers) {
        if (answer.status === 409)
          expect(problemCode(answer.body)).toBe('idempotency_in_flight');
        else expect([200, 201]).toContain(answer.status);
      }
      const later = await fx.createLink(b, Q.id, key, { destination });
      expect([200, 201]).toContain(later.status);
      const codes = new Set(
        [...answers, later]
          .filter((a) => a.status < 300)
          .map((a) => a.body.code),
      );
      expect(codes.size).toBe(1);

      const outside = await fx.createLink(b, Q.id, undefined, {
        destination: 'https://evil.example.org/phish',
      });
      expect(outside.status).toBe(422);
      expect(problemCode(outside.body)).toBe('destination_not_allowed');
    });
  });
  // ------------------------------------------------------------------------------------------------------------------
  describe('US4: the purchase makes the product show up in "bought together"', () => {
    const BASKETS = 'discovery-order-baskets';
    let seller: SellerFixture;
    let P: FixtureProduct;
    let Q: FixtureProduct;
    let R: FixtureProduct;
    let T: FixtureProduct;
    let U: FixtureProduct;
    let buyers: JourneyClient[];
    const firstOrders: { orderId: string; totalMinor: number }[] = [];

    const rail = async (productId: string) => {
      const reply = await fetch(
        `${process.env.API_URL ?? 'http://localhost:8000'}/api/products/${productId}/recommendations`,
      );
      expect(reply.status).toBe(200);
      return recommendationsResponseSchema.parse(await reply.json()).items;
    };
    const railUntil = (
      productId: string,
      ok: (items: Awaited<ReturnType<typeof rail>>) => boolean,
      what: string,
    ) =>
      waitForContract(
        'J05.H11',
        async () => {
          const items = await rail(productId);
          return ok(items) ? items : null;
        },
        what,
      );
    const build = async () => {
      await settled(BASKETS);
      const job = await control.runJob('recommendations.build-bought-together');
      expect(job.status).toBe('SUCCEEDED');
    };
    /** The warehouse takes a few seconds to show a basket the consumer already wrote: build again until the rail has it. */
    const buildUntil = (
      productId: string,
      ok: (items: Awaited<ReturnType<typeof rail>>) => boolean,
      what: string,
    ) =>
      waitForContract(
        'J05.H11',
        async () => {
          await build();
          const items = await rail(productId);
          return ok(items) ? items : null;
        },
        what,
      );

    beforeAll(async () => {
      seller = await createSeller(admin, {
        products: [
          { priceMinor: 2000, quantity: 40 },
          { priceMinor: 1500, quantity: 40 },
          { priceMinor: 1000, quantity: 40 },
          { priceMinor: 900, quantity: 3 }, // sold out by the three first orders
          { priceMinor: 800, quantity: 40 },
        ],
      });
      [P, Q, R, T, U] = seller.products;
      buyers = await Promise.all(
        ['b1', 'b2', 'b3', 'b4'].map((l) => JourneyClient.signUp(`rail-${l}`)),
      );
    });

    it('J05 AS-22: three buyers of the same pair make the rail appear both ways; an archived or sold-out product is not shown', async () => {
      expect(await rail(P.id)).toEqual([]);
      for (const buyer of buyers.slice(0, 3))
        firstOrders.push(
          await fx.buy(buyer, [
            { product: P, quantity: 1 },
            { product: Q, quantity: 1 },
            { product: T, quantity: 1 },
          ]),
        );
      const forP = await buildUntil(
        P.id,
        (items) => items.some((i) => i.productId === Q.id),
        `${Q.id} in the rail of ${P.id}`,
      );
      const q = forP.find((i) => i.productId === Q.id);
      expect(q).toMatchObject({
        hops: 1,
        priceMinor: 1500,
        currency: 'EUR',
      });
      expect(q?.score).toBeGreaterThan(0);
      expect(q?.score).toBeLessThanOrEqual(1);
      // T was sold out by those very orders: visibility is checked at read
      expect(forP.map((i) => i.productId)).not.toContain(T.id);
      expect((await rail(Q.id)).map((i) => i.productId)).toContain(P.id);

      expect((await archive(seller, Q.id)).status).toBeLessThan(300);
      await railUntil(
        P.id,
        (items) => !items.some((i) => i.productId === Q.id),
        `${Q.id} archived leaves the rail`,
      );
      expect((await restore(seller, Q.id)).status).toBeLessThan(300);
      await railUntil(
        P.id,
        (items) => items.some((i) => i.productId === Q.id),
        `${Q.id} restored returns to the rail`,
      );
    });

    it('J05 AS-23: a pair bought by one buyer shows nothing', async () => {
      await fx.buy(buyers[0], [
        { product: P, quantity: 1 },
        { product: R, quantity: 1 },
      ]);
      await build();
      await staysTrue(
        'J05.H11',
        async () => {
          expect((await rail(P.id)).map((i) => i.productId)).not.toContain(
            R.id,
          );
        },
        `${R.id} is not recommended with ${P.id}`,
      );
    });

    it('J05 AS-24: with the basket consumer down the third order is not in the build; after resume and a replay the result equals one delivery each', async () => {
      await fx.buy(buyers[0], [
        { product: P, quantity: 1 },
        { product: U, quantity: 1 },
      ]);
      await fx.buy(buyers[1], [
        { product: P, quantity: 1 },
        { product: U, quantity: 1 },
      ]);
      await settled(BASKETS);
      await control.pause(BASKETS);
      try {
        await fx.buy(buyers[2], [
          { product: P, quantity: 1 },
          { product: U, quantity: 1 },
        ]);
        expect(await control.lag(BASKETS)).toBeGreaterThanOrEqual(1);
        const job = await control.runJob(
          'recommendations.build-bought-together',
        );
        expect(job.status).toBe('SUCCEEDED');
        await staysTrue(
          'J05.H11',
          async () => {
            expect((await rail(P.id)).map((i) => i.productId)).not.toContain(
              U.id,
            );
          },
          `${U.id} needs three orders; the third is not consumed yet`,
        );
      } finally {
        await control.resume(BASKETS);
      }
      const once = await buildUntil(
        P.id,
        (items) => items.some((i) => i.productId === U.id),
        `${U.id} in the rail of ${P.id} after resume`,
      );

      await control.replay(BASKETS, journeyStart);
      await build();
      const replayed = await rail(P.id);
      expect(replayed).toEqual(once);
    });

    it('J05 AS-25: a refund does not retract the rail', async () => {
      const [first] = firstOrders;
      const status = await fx.refundWebhook(
        first.orderId,
        first.totalMinor,
        first.totalMinor,
        new Date((await control.clock()).now).getTime(),
      );
      expect(status).toBe(200);
      await waitOrderStatus(buyers[0], first.orderId, 'REFUNDED', 'H3');
      await build();
      const items = await rail(P.id);
      expect(items.map((i) => i.productId)).toContain(Q.id);
    });
  });
  // ------------------------------------------------------------------------------------------------------------------
  describe('US5: the shopper’s engagement shows up in trending, and a purchase on its own does not', () => {
    const TOPK = 'discovery-trending-topk';
    // views 1, add-to-carts 5; a window closes at its end + lateness (120 s) + idle (30 s): five minutes clears them all
    const WINDOW_CLEARS_S = 300;
    let seller: SellerFixture;
    let P: FixtureProduct;
    let Q: FixtureProduct;
    const category = `aud-${randomUUID().slice(0, 8)}`;
    const visitors = Array.from({ length: 8 }, (_, i) => visitorId(`tv${i}`));
    let firstBatch: StorefrontEvent[] = [];

    const stackNowMs = async () =>
      new Date((await control.clock()).now).getTime();
    const view = (
      anonymousId: string,
      product: FixtureProduct,
      ts: number,
    ): StorefrontEvent => ({
      name: 'product_view',
      anonymousId,
      props: { product_id: product.id, category },
      eventId: randomUUID(),
      ts,
    });
    const cart = (
      anonymousId: string,
      product: FixtureProduct,
      ts: number,
    ): StorefrontEvent => ({
      name: 'add_to_cart',
      anonymousId,
      props: { product_id: product.id, category },
      eventId: randomUUID(),
      ts,
    });
    const scores = async () => {
      const reply = await fetch(
        `${process.env.API_URL ?? 'http://localhost:8000'}/api/trending?category=${category}`,
      );
      expect(reply.status).toBe(200);
      const body = trendingResponseSchema.parse(await reply.json());
      expect(body.windowMinutes).toBe(60);
      return new Map(body.items.map((i) => [i.productId, i.score]));
    };
    const scoresUntil = (
      ok: (found: Map<string, number>) => boolean,
      what: string,
    ) =>
      waitForContract(
        'J05.H13',
        async () => {
          const found = await scores();
          return ok(found) ? found : null;
        },
        what,
      );

    beforeAll(async () => {
      seller = await createSeller(admin, {
        products: [
          { priceMinor: 2000, quantity: 40, category },
          { priceMinor: 1500, quantity: 40, category },
        ],
      });
      [P, Q] = seller.products;
    });

    afterAll(async () => {
      await control.reset();
    });

    it('J05 AS-26: views and add-to-carts rank the products by weighted score once the windows close', async () => {
      const now = await stackNowMs();
      firstBatch = [
        ...visitors.map((v) => view(v, P, now)),
        ...visitors.slice(0, 4).map((v) => cart(v, P, now)),
        ...visitors.slice(0, 2).map((v) => view(v, Q, now)),
      ];
      const reply = await storefrontDouble.post(firstBatch);
      expect(reply.status).toBe(202);
      expect(reply.accepted).toBe(firstBatch.length);
      expect(reply.rejected ?? []).toEqual([]);

      await control.advance(WINDOW_CLEARS_S);
      const found = await scoresUntil(
        (m) => m.get(P.id) === 28 && m.get(Q.id) === 2,
        `P 28 and Q 2 in ${category}`,
      );
      expect([...found.keys()]).toEqual([P.id, Q.id]); // P ranks above Q
    });

    it('J05 AS-27: a paid order on its own does not move trending', async () => {
      const [c1, c2] = await Promise.all([
        JourneyClient.signUp('trend-buyer-1'),
        JourneyClient.signUp('trend-buyer-2'),
      ]);
      for (const buyer of [c1, c2])
        await fx.buy(buyer, [
          { product: P, quantity: 1 },
          { product: Q, quantity: 1 },
        ]);
      await settled(TOPK);
      await staysTrue(
        'J05.H13',
        async () => {
          const found = await scores();
          expect(found.get(P.id)).toBe(28);
          expect(found.get(Q.id)).toBe(2);
        },
        'a purchase leaves the trending scores alone',
      );
    });

    it('J05 AS-28: the same event ids change nothing; a bad product id counts for nothing; a consumer down loses nothing', async () => {
      // the same batch, the same event ids
      const again = await storefrontDouble.post(firstBatch);
      expect(again.status).toBe(202);
      await control.advance(WINDOW_CLEARS_S);
      await settled(TOPK);
      await staysTrue(
        'J05.H13',
        async () => {
          const found = await scores();
          expect(found.get(P.id)).toBe(28);
          expect(found.get(Q.id)).toBe(2);
        },
        'a resent batch leaves the scores alone',
      );

      // one event whose product id is not a UUID: refused alone, the other counts
      const fresh = visitorId('tv-bad');
      const now = await stackNowMs();
      const mixed = await storefrontDouble.post([
        {
          name: 'product_view',
          anonymousId: fresh,
          props: { product_id: 'not-a-uuid', category },
          ts: now,
        },
        view(fresh, Q, now),
      ]);
      expect(mixed.status).toBe(202);
      // the collector's rules are generic (props are free strings): the bad id passes ingestion and is refused alone by the
      // trending consumer, which counts nothing for it (gaps.md, 'Spec deviations')
      expect(mixed.accepted).toBe(2);
      expect(mixed.rejected ?? []).toEqual([]);
      await control.advance(WINDOW_CLEARS_S);
      await scoresUntil(
        (m) => m.get(Q.id) === 3,
        'Q 3 after the one valid view',
      );

      // the consumer down for one batch of three add-to-carts
      await control.pause(TOPK);
      try {
        const stamp = await stackNowMs();
        const batch = Array.from({ length: 3 }, (_, i) =>
          cart(visitorId(`tv-down${i}`), P, stamp),
        );
        expect((await storefrontDouble.post(batch)).status).toBe(202);
        // the collector hands the batch to the log asynchronously: the lag shows once the events are published
        await waitFor(async () => (await control.lag(TOPK)) >= 1, {
          timeoutMs: 20_000,
          intervalMs: 250,
          description: 'lag of discovery-trending-topk >= 1',
        });
      } finally {
        await control.resume(TOPK);
      }
      // the commit floor stays at the oldest open window: the windows close with the clock, then the group is caught up
      await control.advance(WINDOW_CLEARS_S);
      await settledByClock(TOPK);
      await scoresUntil(
        (m) => m.get(P.id) === 28 + 15,
        'P rises by exactly 15',
      );
    });

    it('J05 AS-29: an archived product leaves the ranking', async () => {
      expect((await archive(seller, P.id)).status).toBeLessThan(300);
      const found = await waitForContract(
        'J05.H3',
        async () => {
          const m = await scores();
          return m.has(P.id) ? null : m;
        },
        `${P.id} archived leaves trending`,
      );
      expect(found.has(Q.id)).toBe(true);
    });
  });
  // ------------------------------------------------------------------------------------------------------------------
  describe('US6: the purchase shows up in the A/B experiment results exactly once', () => {
    const GROUP = 'experimentation-purchases';
    let seller: SellerFixture;
    let P: FixtureProduct;
    type Results = Awaited<ReturnType<typeof fx.results>>;
    const stackNowMs = async () =>
      new Date((await control.clock()).now).getTime();
    const exposure = (
      key: string,
      variant: string,
      ts: number,
      eventId?: string,
    ): StorefrontEvent => ({
      name: 'exposure',
      anonymousId: visitorId('ex'),
      props: { experiment: key, variant },
      eventId: eventId ?? randomUUID(),
      ts,
    });
    const variantOf = (r: Results, variant: string) =>
      r.variants.find((v) => v.variant === variant) ?? {
        variant,
        exposures: 0,
        conversions: 0,
      };
    const resultsUntil = (
      key: string,
      ok: (r: Results) => boolean,
      what: string,
    ) =>
      waitForContract(
        'J05.H14',
        async () => {
          const r = await fx.results(admin, key);
          return ok(r) ? r : null;
        },
        what,
      );
    const buyOne = (buyer: JourneyClient) =>
      fx.buy(buyer, [{ product: P, quantity: 1 }]);

    beforeAll(async () => {
      seller = await createSeller(admin, {
        products: [{ priceMinor: 1800, quantity: 80 }],
      });
      [P] = seller.products;
    });

    it('J05 AS-30: an exposed shopper who pays converts once in their variant; assignment is stable; results are admin only', async () => {
      const key = unique('j05-ex').toLowerCase();
      await fx.createExperiment(admin, key);
      const buyer = await JourneyClient.signUp('exposed');
      const variant = await fx.assignment(buyer, key);
      expect(['control', 'treatment']).toContain(variant);
      for (let i = 0; i < 3; i++)
        expect(await fx.assignment(buyer, key)).toBe(variant);

      const other = variant === 'control' ? 'treatment' : 'control';
      const posted = await storefrontDouble.postAs(buyer, [
        exposure(key, variant!, await stackNowMs()),
      ]);
      expect(posted.status).toBe(202);
      expect(posted.accepted).toBe(1);
      await resultsUntil(
        key,
        (r) => variantOf(r, variant!).exposures === 1,
        `1 exposure in ${variant}`,
      );

      await buyOne(buyer);
      const results = await resultsUntil(
        key,
        (r) => variantOf(r, variant!).conversions === 1,
        `1 conversion in ${variant}`,
      );
      expect(variantOf(results, variant!)).toMatchObject({
        exposures: 1,
        conversions: 1,
      });
      expect(variantOf(results, other)).toMatchObject({
        exposures: 0,
        conversions: 0,
      });
      expect(results).toMatchObject({
        experiment: key,
        unit: 'user',
        metric: 'purchase',
      });

      const route = `/api/admin/experiments/${key}/results`;
      expect((await buyer.get(route)).status).toBe(403);
      const anonymous = await fetch(
        `${process.env.API_URL ?? 'http://localhost:8000'}${route}`,
      );
      expect(anonymous.status).toBe(401);
    });

    it('J05 AS-31: a purchase before the exposure does not count; a unit converts at most once however many orders', async () => {
      const key = unique('j05-ex').toLowerCase();
      await fx.createExperiment(admin, key);
      const c1 = await JourneyClient.signUp('early-buyer');
      const variant = (await fx.assignment(c1, key))!;
      await buyOne(c1); // paid before the exposure

      await control.advance(60); // the exposure is later than the payment
      expect(
        (
          await storefrontDouble.postAs(c1, [
            exposure(key, variant, await stackNowMs()),
          ])
        ).status,
      ).toBe(202);
      const exposed = await resultsUntil(
        key,
        (r) => variantOf(r, variant).exposures === 1,
        'the late exposure is counted',
      );
      expect(variantOf(exposed, variant).conversions).toBe(0);
      await settled(GROUP);
      expect(variantOf(await fx.results(admin, key), variant).conversions).toBe(
        0,
      );

      await buyOne(c1);
      await resultsUntil(
        key,
        (r) => variantOf(r, variant).conversions === 1,
        'the order after the exposure converts',
      );
      await buyOne(c1);
      await settled(GROUP);
      await staysTrue(
        'J05.H14',
        async () => {
          expect(
            variantOf(await fx.results(admin, key), variant),
          ).toMatchObject({ exposures: 1, conversions: 1 });
        },
        'a second order after the exposure leaves one conversion',
      );
    });

    it('J05 AS-32: the same exposure again and a replay of the purchases change no number; a paused consumer loses nothing', async () => {
      const key = unique('j05-ex').toLowerCase();
      await fx.createExperiment(admin, key);
      const buyer = await JourneyClient.signUp('replayed');
      const variant = (await fx.assignment(buyer, key))!;
      const event = exposure(key, variant, await stackNowMs(), randomUUID());
      expect((await storefrontDouble.postAs(buyer, [event])).status).toBe(202);
      await resultsUntil(
        key,
        (r) => variantOf(r, variant).exposures === 1,
        'exposed',
      );
      await buyOne(buyer);
      await resultsUntil(
        key,
        (r) => variantOf(r, variant).conversions === 1,
        'converted',
      );

      // the same event id again, then a replay of the order stream from the start of the run
      await storefrontDouble.postAs(buyer, [event]);
      await control.replay(GROUP, journeyStart);
      await settled(GROUP);
      await staysTrue(
        'J05.H14',
        async () => {
          expect(
            variantOf(await fx.results(admin, key), variant),
          ).toMatchObject({ exposures: 1, conversions: 1 });
        },
        'duplicates and a replay change no number',
      );

      // a second shopper pays while the consumer is paused: the results lag, then count it once
      const late = await JourneyClient.signUp('paused-buyer');
      const lateVariant = (await fx.assignment(late, key))!;
      expect(
        (
          await storefrontDouble.postAs(late, [
            exposure(key, lateVariant, await stackNowMs()),
          ])
        ).status,
      ).toBe(202);
      await resultsUntil(
        key,
        (r) => variantOf(r, lateVariant).exposures >= 1,
        'exposed',
      );
      const before = variantOf(
        await fx.results(admin, key),
        lateVariant,
      ).conversions;
      await control.pause(GROUP);
      try {
        await buyOne(late);
        expect(await control.lag(GROUP)).toBeGreaterThanOrEqual(1);
        expect(
          variantOf(await fx.results(admin, key), lateVariant).conversions,
        ).toBe(before);
      } finally {
        await control.resume(GROUP);
      }
      await settled(GROUP);
      await resultsUntil(
        key,
        (r) => variantOf(r, lateVariant).conversions === before + 1,
        'the paused purchase counts once after the resume',
      );
    });

    it('J05 AS-33: an anonymous exposure is not joined to the same person after sign-in: no conversion, counted as unattributable', async () => {
      const key = unique('j05-ex').toLowerCase();
      await fx.createExperiment(admin, key);
      const person = await JourneyClient.signUp('stitched');
      const variant = (await fx.assignment(person, key))!;
      const posted = await storefrontDouble.post([
        {
          name: 'exposure',
          anonymousId: visitorId('anon'),
          props: { experiment: key, variant },
          ts: await stackNowMs(),
        },
      ]);
      expect(posted.status).toBe(202);
      await buyOne(person);
      await settled(GROUP);
      const results = await resultsUntil(
        key,
        (r) => r.excluded.unattributable > 0,
        'the anonymous exposure is excluded as unattributable',
      );
      expect(variantOf(results, variant)).toMatchObject({
        exposures: 0,
        conversions: 0,
      });
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe('US7: the whole loop survives replay and has one front door', () => {
    const GROUPS = [
      'community-feed-products',
      'community-feed-discussions',
      'community-feed-fanout',
      'marketing-link-clicks',
      'marketing-affiliate-conversions',
      'discovery-order-baskets',
      'discovery-trending-topk',
      'experimentation-purchases',
    ];
    let seller: SellerFixture;
    let P: FixtureProduct;
    let b: JourneyClient;
    let f: JourneyClient;
    let code = '';
    let key = '';

    /** Everything a reader of the loop sees, minus the times that move. */
    const observe = async () => {
      const feed = await fx.feed(b);
      const comments = await itemsOf(b, 'discussion.comment');
      const stats = await fx.stats(b, code);
      const conversions = await fx.conversions(b, code);
      const results = await fx.results(admin, key);
      const rail = await fetch(
        `${process.env.API_URL ?? 'http://localhost:8000'}/api/products/${P.id}/recommendations`,
      );
      return {
        feed: feed.map((i) => `${i.kind}:${i.itemId}`).sort(),
        comments: comments.map((i) => i.id).sort(),
        unread: await unreadCount(b),
        stats: {
          total: stats.total,
          conversions: stats.conversions,
          convertedMinor: stats.convertedMinor,
        },
        conversions: conversions.map((c) => [
          c.conversionId,
          c.status,
          c.amountMinor,
          c.refundedMinor,
        ]),
        experiment: {
          variants: results.variants
            .map((v) => [v.variant, v.exposures, v.conversions])
            .sort(),
          excluded: results.excluded,
        },
        rail: {
          status: rail.status,
          body: await rail.json().catch(() => null),
        },
      };
    };

    beforeAll(async () => {
      seller = await createSeller(admin, {
        products: [{ priceMinor: 2200, quantity: 60 }],
      });
      [P] = seller.products;
      [b, f] = await Promise.all([
        JourneyClient.signUp('replay-b'),
        JourneyClient.signUp('replay-f'),
      ]);
      expect(await fx.follow(b, accountOf(seller))).toBeLessThan(300);
      await settled('notification-router'); // a replay of an earlier run leaves the group rebalancing
      const board = await fx.post(b, P.id);
      expect(board.status).toBe(201);
      expect(
        (await fx.comment(seller.owner, board.body.postId)).status,
      ).toBeLessThan(300);
      await waitForItems('J05.H6', b, 'discussion.comment', 1);
      code = (await fx.linkOf(b, P.id)).code;
      key = unique('j05-ex').toLowerCase();
      await fx.createExperiment(admin, key);
      const variant = (await fx.assignment(f, key))!;
      const now = new Date((await control.clock()).now).getTime();
      expect(
        (
          await storefrontDouble.postAs(f, [
            {
              name: 'exposure',
              anonymousId: visitorId('rp'),
              props: { experiment: key, variant },
              ts: now,
            },
          ])
        ).status,
      ).toBe(202);
      await waitForContract(
        'J05.H14',
        async () =>
          (await fx.results(admin, key)).variants.some((v) => v.exposures === 1)
            ? true
            : null,
        'the exposure',
      );
      await fx.buy(f, [{ product: P, quantity: 1 }], { ref: code });
      await waitForContract(
        'J05.H9',
        async () => ((await fx.conversions(b, code)).length >= 1 ? true : null),
        'the conversion',
      );
      await waitForContract(
        'J05.H14',
        async () =>
          (await fx.results(admin, key)).variants.some(
            (v) => v.conversions === 1,
          )
            ? true
            : null,
        'the experiment conversion',
      );
    });

    it('J05 AS-35: replaying every group from the journey start and rebuilding changes no observable', async () => {
      for (const group of GROUPS)
        await (group === 'discovery-trending-topk'
          ? settledByClock(group)
          : settled(group));
      const before = await observe();
      expect(before.feed.length).toBeGreaterThan(0);
      expect(before.conversions).toHaveLength(1);

      // trending keeps open windows in memory and says so: replaying it is refused (S35), the others replay from the start
      const refused = await admin.post(
        '/api/admin/consumers/discovery-trending-topk/replay',
        { body: { since: journeyStart.toISOString() } },
      );
      expect(refused.status).toBe(409);
      expect(problemCode(refused.body)).toBe('consumer_not_replayable');
      for (const group of GROUPS.filter((g) => g !== 'discovery-trending-topk'))
        await control.replay(group, journeyStart);
      await control.replay('notification-router', journeyStart);
      await control.runJob('recommendations.build-bought-together');
      for (const group of GROUPS)
        await (group === 'discovery-trending-topk'
          ? settledByClock(group)
          : settled(group));

      await staysTrue(
        'J05.H15',
        async () => expect(await observe()).toEqual(before),
        'every observable is unchanged after the replay',
      );
    }, 300_000);

    it('J05 AS-36: nothing the link owner, the tap or the log shows names the buyer, a key or an event prop', async () => {
      const owner = JSON.stringify([
        await fx.conversions(b, code),
        await fx.stats(b, code),
      ]);
      const tapped = JSON.stringify(
        (await eventTap('links.events', { key: code })).map((m) => m.payload),
      );
      for (const text of [owner, tapped]) {
        expect(text).not.toContain(f.userId);
        expect(text).not.toMatch(/@example\.com/);
        expect(text).not.toMatch(/orderId|idempotency/i);
      }
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/);

      const log = apiLogPath();
      if (log) {
        const lines = logLinesSince(log, logStart);
        const text = lines.join('\n');
        expect(text).not.toMatch(/[a-z0-9-]+@example\.com/);
        // the experiment key is a prop value of the exposure events; only the admin's own audit line may name it
        expect(
          lines.filter(
            (l) => l.includes(key) && !l.includes('ExperimentCommandService'),
          ),
        ).toEqual([]);
        expect(text).not.toMatch(/"props"\s*:/);
      }
    });

    it('J05 AS-37: the static gates pass', () => {
      const backend = resolve(__dirname, '../..');
      for (const args of [
        ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.json'],
        [
          'exec',
          'eslint',
          'libs/domains/{community,discovery,experimentation,marketing,orders}/**/*.ts',
        ],
        ['check:boundaries'],
        ['check:table-ownership', '--strict'],
        ['check:module-graph'],
        ['check:model-registry'],
      ] as string[][]) {
        const r = spawnSync('pnpm', args, {
          cwd: backend,
          encoding: 'utf8',
          timeout: 540_000,
        });
        expect([
          args.join(' '),
          r.status,
          (r.stdout + r.stderr).slice(-800),
        ]).toEqual([args.join(' '), 0, expect.any(String)]);
      }
    }, 3_000_000);
  });
});
