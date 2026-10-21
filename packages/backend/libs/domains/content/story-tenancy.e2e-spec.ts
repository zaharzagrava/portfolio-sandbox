import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { ownershipCheck } from '@app/test/utils/static-checks';
import { v4, v7 as uuidv7 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { SequelizeShopCopyRepository } from './infra/shop-copy.repository';
import { readModelKey } from './infra/story-read-model';
import {
  deliver,
  envelope,
  shopCreatedEvent,
  shopDeletedEvent,
  shopStatusEvent,
  shopUpdatedEvent,
} from './testing/events';
import {
  PREVIEW_SECRET,
  REVALIDATE_SECRET,
  createStoryApp,
  type Seller,
  type StoryTestApp,
} from './testing/story-client';

describe('Brand stories: authentication, tenant isolation, shop lifecycle, rate limit and operations', () => {
  let t: StoryTestApp;
  beforeAll(async () => {
    t = await createStoryApp({ captureLogs: true });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    t.cdn.reset();
    t.front.reset();
  });

  const copyOf = async (shopId: string) =>
    (
      await t.rows<{
        slug: string | null;
        status: string;
        shopVersion: string;
      }>(
        `SELECT "slug", "status", "shopVersion" FROM "StoryShop" WHERE "shopId" = :shopId`,
        { shopId },
      )
    )[0];
  const storyRows = async (shopId: string) =>
    Number(
      (
        await t.rows<{ n: string }>(
          `SELECT count(*) AS n FROM "Story" WHERE "shopId" = :shopId`,
          { shopId },
        )
      )[0].n,
    );
  const childRows = async (shopId: string) => ({
    drafts: Number(
      (
        await t.rows<{ n: string }>(
          `SELECT count(*) AS n FROM "StoryDraft" WHERE "shopId" = :shopId`,
          { shopId },
        )
      )[0].n,
    ),
    versions: Number(
      (
        await t.rows<{ n: string }>(
          `SELECT count(*) AS n FROM "StoryVersion" WHERE "shopId" = :shopId`,
          { shopId },
        )
      )[0].n,
    ),
    history: Number(
      (
        await t.rows<{ n: string }>(
          `SELECT count(*) AS n FROM "StoryTransition" WHERE "shopId" = :shopId`,
          { shopId },
        )
      )[0].n,
    ),
  });
  const shopRow = async (shopId: string) =>
    (
      await t.rows<{ slug: string; status: string }>(
        `SELECT "slug", "status" FROM "Shop" WHERE "id" = :shopId`,
        { shopId },
      )
    )[0];

  // ------------------------------------------------------------------------------------------------ AS-97

  it('S27 AS-97: shop_created makes the copy and a newer shop_updated moves its version', async () => {
    const shopId = uuidv7();
    const slug = `acme-${v4().slice(0, 8)}`;
    await deliver(t.shopCopy, shopCreatedEvent(shopId, slug, 1));
    expect(await copyOf(shopId)).toMatchObject({
      slug,
      status: 'ACTIVE',
      shopVersion: '1',
    });
    await deliver(t.shopCopy, shopUpdatedEvent(shopId, slug, 3));
    expect(await copyOf(shopId)).toMatchObject({ slug, shopVersion: '3' });
  });

  it('S27 AS-97: an event with a version not greater than the stored one is ignored, a duplicate included', async () => {
    const shopId = uuidv7();
    const slug = `acme-${v4().slice(0, 8)}`;
    await deliver(t.shopCopy, shopCreatedEvent(shopId, slug, 5));
    await deliver(
      t.shopCopy,
      shopStatusEvent(shopId, 'ACTIVE', 'SUSPENDED', 6),
    );
    const before = await copyOf(shopId);
    const older = shopStatusEvent(shopId, 'SUSPENDED', 'ACTIVE', 4);
    await deliver(t.shopCopy, older);
    await deliver(t.shopCopy, older);
    await deliver(t.shopCopy, shopUpdatedEvent(shopId, slug, 2));
    await deliver(t.shopCopy, shopStatusEvent(shopId, 'ACTIVE', 'DELETING', 6));
    expect(await copyOf(shopId)).toEqual(before);
    expect(before).toMatchObject({ status: 'SUSPENDED', shopVersion: '6' });
  });

  it('S27 AS-97: shop_status_changed before shop_created creates the copy and the older shop_created does not regress it', async () => {
    const shopId = uuidv7();
    await deliver(
      t.shopCopy,
      shopStatusEvent(shopId, 'ACTIVE', 'SUSPENDED', 7),
    );
    expect(await copyOf(shopId)).toMatchObject({
      slug: null,
      status: 'SUSPENDED',
      shopVersion: '7',
    });
    const slug = `late-${v4().slice(0, 8)}`;
    await deliver(t.shopCopy, shopCreatedEvent(shopId, slug, 1));
    expect(await copyOf(shopId)).toMatchObject({
      slug,
      status: 'SUSPENDED',
      shopVersion: '7',
    });
  });

  it('S27 AS-97: the slug is set once; a later different slug does not change it', async () => {
    const shopId = uuidv7();
    const first = `first-${v4().slice(0, 8)}`;
    await deliver(t.shopCopy, shopCreatedEvent(shopId, first, 1));
    await deliver(
      t.shopCopy,
      shopUpdatedEvent(shopId, `second-${v4().slice(0, 8)}`, 2),
    );
    expect(await copyOf(shopId)).toMatchObject({
      slug: first,
      shopVersion: '2',
    });
  });

  it.each([
    [
      'missing shopId',
      envelope('tenancy.shop_created', 'tenancy', uuidv7(), {
        name: 'x',
        slug: 'x',
        plan: 'STARTER',
        region: 'r',
        shopVersion: 1,
        ownerId: null,
      }),
    ],
    [
      'wrong type',
      envelope('tenancy.shop_updated', 'tenancy', uuidv7(), {
        shopId: 12,
        name: 'x',
        slug: 'x',
        shopVersion: 1,
      }),
    ],
    [
      'shopId that is not a uuid',
      envelope('tenancy.shop_deleted', 'tenancy', 'x', {
        shopId: 'not-a-uuid',
      }),
    ],
    [
      'unknown version',
      envelope(
        'tenancy.shop_created',
        'tenancy',
        uuidv7(),
        { shopId: uuidv7() },
        1,
        9,
      ),
    ],
  ])(
    'S27 AS-97: an invalid payload (%s) is dead-lettered without a write',
    async (_name, event) => {
      const before = await t.rows<{ n: string }>(
        `SELECT count(*) AS n FROM "StoryShop"`,
      );
      const result = await deliver(t.shopCopy, event);
      expect(result.delivered).toBe(false);
      expect(
        await t.rows<{ n: string }>(`SELECT count(*) AS n FROM "StoryShop"`),
      ).toEqual(before);
    },
  );

  it('S27 AS-97: replaying the whole topic into an empty copy rebuilds the same state, and tenancy is never written', async () => {
    const s = await t.seller();
    const shop = await shopRow(s.shopId);
    const events = [
      shopCreatedEvent(s.shopId, s.shopSlug, 1),
      shopUpdatedEvent(s.shopId, s.shopSlug, 2),
      shopStatusEvent(s.shopId, 'ACTIVE', 'SUSPENDED', 3),
      shopStatusEvent(s.shopId, 'SUSPENDED', 'ACTIVE', 4),
    ];
    for (const e of events) await deliver(t.shopCopy, e);
    const built = await copyOf(s.shopId);
    await t.rows(`DELETE FROM "StoryShop" WHERE "shopId" = :shopId`, {
      shopId: s.shopId,
    });
    for (const e of events) await deliver(t.shopCopy, e);
    expect(await copyOf(s.shopId)).toEqual(built);
    // out of order gives the same final state
    await t.rows(`DELETE FROM "StoryShop" WHERE "shopId" = :shopId`, {
      shopId: s.shopId,
    });
    for (const e of [...events].reverse()) await deliver(t.shopCopy, e);
    expect(await copyOf(s.shopId)).toEqual(built);
    expect(built).toMatchObject({
      slug: s.shopSlug,
      status: 'ACTIVE',
      shopVersion: '4',
    });
    expect(await shopRow(s.shopId)).toEqual(shop);
  });

  // ------------------------------------------------------------------------------------------------ AS-98

  const seedStories = async (s: Seller, count: number) => {
    // bulk rows straight into the tables (test code may touch every table, IX.6)
    await t.rows(
      `INSERT INTO "Story" ("id", "shopId", "slug", "defaultLocale", "status", "createdAt")
       SELECT uuidv7(), :shopId, 'bulk-' || g, 'en', 'DRAFT', now() FROM generate_series(1, :count) g`,
      { shopId: s.shopId, count },
    );
  };

  it('S27 AS-98: shop_deleted removes the shop’s stories, drafts, versions, history, copy and origin entries; others are untouched', async () => {
    const a = await t.seller();
    const b = await t.seller();
    await t.syncShop(a);
    await t.syncShop(b);
    const doomed = await t.published(a, { locales: ['en', 'uk'] });
    await t.published(a);
    const kept = await t.published(b);
    // warm the origin entry of the doomed story
    await t
      .http()
      .get(`/api/stories/${a.shopSlug}/${doomed.slug}/en`)
      .expect(200);
    const redis = t.app.get(RedisService);
    expect(
      await redis.client.exists(readModelKey(a.shopSlug, doomed.slug)),
    ).toBe(1);
    expect((await childRows(a.shopId)).versions).toBeGreaterThan(0);

    const result = await deliver(t.shopCopy, shopDeletedEvent(a.shopId));
    expect(result.delivered).toBe(true);

    expect(await storyRows(a.shopId)).toBe(0);
    expect(await childRows(a.shopId)).toEqual({
      drafts: 0,
      versions: 0,
      history: 0,
    });
    expect(await copyOf(a.shopId)).toBeUndefined();
    expect(
      await redis.client.exists(readModelKey(a.shopSlug, doomed.slug)),
    ).toBe(0);
    // the shop tag is purged at the CDN and the front end is told
    expect(t.cdn.bodies<{ tags: string[] }>().flatMap((b) => b.tags)).toContain(
      `shop:${a.shopId}`,
    );
    expect(
      t.front.bodies<{ tags: string[] }>().flatMap((b) => b.tags),
    ).toContain(`shop:${a.shopId}`);
    // the other shop is untouched
    expect(await storyRows(b.shopId)).toBe(1);
    expect((await childRows(b.shopId)).versions).toBe(1);
    await t
      .http()
      .get(`/api/stories/${b.shopSlug}/${kept.slug}/en`)
      .expect(200);
    await t
      .http()
      .get(`/api/stories/${a.shopSlug}/${doomed.slug}/en`)
      .expect(404);
  });

  it('S27 AS-98: delivering shop_deleted twice, or after a failure half-way, ends in the same empty state', async () => {
    const a = await t.seller();
    await t.syncShop(a);
    await t.published(a);
    await t.published(a);
    const other = await t.seller();
    await t.syncShop(other);
    await t.published(other);

    // the CDN is down: the purge fails after the rows are gone, so the event is redelivered
    t.cdn.defaultStatus = 503;
    await expect(
      deliver(t.shopCopy, shopDeletedEvent(a.shopId)),
    ).rejects.toBeDefined();
    expect(await storyRows(a.shopId)).toBe(0);
    expect(await copyOf(a.shopId)).toBeDefined();
    // recovered: the redelivery finishes
    t.cdn.reset();
    await deliver(t.shopCopy, shopDeletedEvent(a.shopId));
    expect(await copyOf(a.shopId)).toBeUndefined();
    // and once more changes nothing
    await deliver(t.shopCopy, shopDeletedEvent(a.shopId));
    expect(await storyRows(a.shopId)).toBe(0);
    expect(await childRows(a.shopId)).toEqual({
      drafts: 0,
      versions: 0,
      history: 0,
    });
    expect(await storyRows(other.shopId)).toBe(1);
  });

  it('S27 AS-98: the purge runs in bounded batches', async () => {
    const a = await t.seller();
    await t.syncShop(a);
    await seedStories(a, 130);
    expect(await storyRows(a.shopId)).toBe(130);
    const spy = jest.spyOn(SequelizeShopCopyRepository.prototype, 'purgeBatch');
    try {
      await deliver(t.shopCopy, shopDeletedEvent(a.shopId));
      const sizes = await Promise.all(
        spy.mock.results.map((r) => r.value as Promise<string[]>),
      );
      expect(sizes.length).toBeGreaterThanOrEqual(3);
      for (const slugs of sizes) expect(slugs.length).toBeLessThanOrEqual(50);
      expect(sizes.reduce((n, slugs) => n + slugs.length, 0)).toBe(130);
    } finally {
      spy.mockRestore();
    }
    expect(await storyRows(a.shopId)).toBe(0);
  });

  it('S27 AS-98: the old slug can be registered again without exposing old content', async () => {
    const old = await t.seller();
    await t.syncShop(old);
    const oldStory = await t.published(old, { slug: 'launch' });
    await deliver(t.shopCopy, shopDeletedEvent(old.shopId));
    const fresh = await t.seller();
    await deliver(t.shopCopy, shopCreatedEvent(fresh.shopId, old.shopSlug, 1));
    await t
      .http()
      .get(`/api/stories/${old.shopSlug}/${oldStory.slug}/en`)
      .expect(404);
    const story = await t.published(fresh, { slug: 'launch' });
    const res = await t
      .http()
      .get(`/api/stories/${old.shopSlug}/${story.slug}/en`)
      .expect(200);
    expect(res.body.shopId).toBe(fresh.shopId);
  });

  // ------------------------------------------------------------------------------------------------ routes

  interface Route {
    name: string;
    method: 'get' | 'post' | 'put' | 'delete';
    path: (shopId: string, storyId: string) => string;
    body?: object;
    /** Needs `products.read` only (the list); the rest needs `products.write`. */
    read?: boolean;
    key?: boolean;
  }
  const routes: Route[] = [
    {
      name: 'create',
      method: 'post',
      path: (s) => `/api/shops/${s}/stories`,
      body: { slug: 'idor-new' },
    },
    {
      name: 'list',
      method: 'get',
      path: (s) => `/api/shops/${s}/stories`,
      read: true,
    },
    {
      name: 'detail',
      method: 'get',
      path: (s, id) => `/api/shops/${s}/stories/${id}`,
    },
    {
      name: 'save draft',
      method: 'put',
      path: (s, id) => `/api/shops/${s}/stories/${id}/drafts/en`,
      body: { title: 'x', blocks: [], expectedRevision: 0 },
    },
    {
      name: 'delete draft',
      method: 'delete',
      path: (s, id) =>
        `/api/shops/${s}/stories/${id}/drafts/uk?expectedRevision=1`,
    },
    {
      name: 'publish',
      method: 'post',
      path: (s, id) => `/api/shops/${s}/stories/${id}/publish`,
      body: { expectedVersion: 1 },
      key: true,
    },
    {
      name: 'cancel schedule',
      method: 'delete',
      path: (s, id) => `/api/shops/${s}/stories/${id}/schedule`,
    },
    {
      name: 'archive',
      method: 'post',
      path: (s, id) => `/api/shops/${s}/stories/${id}/archive`,
    },
    {
      name: 'versions',
      method: 'get',
      path: (s, id) => `/api/shops/${s}/stories/${id}/versions`,
    },
    {
      name: 'version',
      method: 'get',
      path: (s, id) => `/api/shops/${s}/stories/${id}/versions/1`,
    },
    {
      name: 'restore',
      method: 'post',
      path: (s, id) => `/api/shops/${s}/stories/${id}/versions/1/restore`,
    },
    {
      name: 'preview token',
      method: 'post',
      path: (s, id) => `/api/shops/${s}/stories/${id}/preview-token`,
      body: { locale: 'en' },
    },
  ];
  const call = (
    route: Route,
    auth: Record<string, string> | undefined,
    shopId: string,
    storyId: string,
  ) => {
    let req = t.http()[route.method](route.path(shopId, storyId));
    if (auth) req = req.set(auth);
    if (route.key) req = req.set('Idempotency-Key', `key-${v4()}`);
    return route.body ? req.send(route.body) : req.send();
  };
  const problemShape = (r: {
    status: number;
    body: Record<string, unknown>;
  }) => ({
    status: r.status,
    type: r.body.type,
    title: r.body.title,
    detail: r.body.detail,
    code: r.body.code,
  });

  // ------------------------------------------------------------------------------------------------ AS-90

  it.each(routes.map((r) => [r.name, r] as const))(
    'S27 AS-90: %s without a session, or with an invalid one, is 401 problem+json and changes nothing',
    async (_name, route) => {
      const s = await t.seller();
      const story = await t.published(s);
      const before = await storyRows(s.shopId);
      const none = await call(route, undefined, s.shopId, story.id);
      const bad = await call(
        route,
        { Authorization: 'Bearer not.a.session' },
        s.shopId,
        story.id,
      );
      for (const res of [none, bad]) {
        expect(res.status).toBe(401);
        expect(res.headers['content-type']).toMatch(
          /application\/problem\+json/,
        );
      }
      expect(await storyRows(s.shopId)).toBe(before);
      expect((await childRows(s.shopId)).versions).toBe(1);
      expect(await t.outbox(story.id)).toHaveLength(1);
    },
  );

  // ------------------------------------------------------------------------------------------------ AS-91

  it('S27 AS-91: a viewer can list but every other staff route is 403 permission_denied', async () => {
    const s = await t.seller();
    const story = await t.published(s);
    const viewer = await t.member(s.shopId, 'VIEWER');
    for (const route of routes) {
      const res = await call(route, viewer.auth, s.shopId, story.id);
      if (route.read) expect(res.status).toBe(200);
      else {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('permission_denied');
      }
    }
    expect(await storyRows(s.shopId)).toBe(1);
    expect(await t.outbox(story.id)).toHaveLength(1);
  });

  it('S27 AS-91: a non-member gets the same 404 shop_not_found as for an unknown shop, on every route', async () => {
    const s = await t.seller();
    const story = await t.published(s);
    const outsider = await t.seller();
    for (const route of routes) {
      const res = await call(route, outsider.auth, s.shopId, story.id);
      const unknown = await call(route, outsider.auth, uuidv7(), story.id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('shop_not_found');
      expect(problemShape(res)).toEqual(problemShape(unknown));
    }
  });

  // ------------------------------------------------------------------------------------------------ AS-92

  it('S27 AS-92: another shop’s story is a 404 story_not_found like an unknown one on every route, and nothing of it changes', async () => {
    const e = await t.seller();
    const owner = await t.seller();
    await t.syncShop(owner);
    const foreign = await t.published(owner, { locales: ['en', 'uk'] });
    await t.get(owner, `/api/stories/${owner.shopSlug}/${foreign.slug}/en`);
    const redis = t.app.get(RedisService);
    const key = readModelKey(owner.shopSlug, foreign.slug);
    const snapshot = async () => ({
      story: await t.rows(`SELECT * FROM "Story" WHERE "id" = :id`, {
        id: foreign.id,
      }),
      drafts: await t.rows(
        `SELECT * FROM "StoryDraft" WHERE "storyId" = :id ORDER BY "locale"`,
        { id: foreign.id },
      ),
      versions: await childRows(owner.shopId),
      events: (await t.outbox(foreign.id)).length,
      cached: await redis.client.exists(key),
    });
    const before = JSON.stringify(await snapshot());
    for (const route of routes.filter((r) => !r.read && r.name !== 'create')) {
      const res = await call(route, e.auth, e.shopId, foreign.id);
      const unknown = await call(route, e.auth, e.shopId, uuidv7());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('story_not_found');
      expect(problemShape(res)).toEqual(problemShape(unknown));
      const malformed = await call(route, e.auth, e.shopId, 'not-a-uuid');
      expect(malformed.status).toBe(400);
      expect(malformed.body.code).toBe('validation_failed');
    }
    expect(JSON.stringify(await snapshot())).toBe(before);
    const list = await t.get(e, `/api/shops/${e.shopId}/stories`).expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(
      foreign.id,
    );
  });

  // ------------------------------------------------------------------------------------------------ AS-93

  /** A published story with one version straight into the tables (the shop is closed, so no route can make one). */
  const plantPublished = async (s: Seller): Promise<string> => {
    const id = uuidv7();
    await t.rows(
      `INSERT INTO "Story" ("id", "shopId", "slug", "defaultLocale", "status", "publishedVersion", "publishedAt", "createdAt")
       VALUES (:id, :shopId, 'planted', 'en', 'PUBLISHED', 1, now(), now())`,
      { id, shopId: s.shopId },
    );
    await t.rows(
      `INSERT INTO "StoryVersion" ("storyId", "shopId", "version", "locale", "title", "blocks", "seo", "createdAt", "publishedAt")
       VALUES (:id, :shopId, 1, 'en', 'T', '[]'::jsonb, '{}'::jsonb, now(), now())`,
      { id, shopId: s.shopId },
    );
    return id;
  };

  it.each([
    ['SUSPENDED', 403, 'shop_suspended'],
    ['DELETING', 409, 'shop_offboarding'],
  ] as const)(
    'S27 AS-93: a %s shop refuses story writes with %i %s and nothing changes',
    async (status, httpStatus, code) => {
      // the shop is closed from the start (the access check keeps a status for 15 s), its stories are planted
      const s = await t.seller({ status });
      const story = await plantPublished(s);
      for (const route of routes.filter((r) => !r.read)) {
        const res = await call(route, s.auth, s.shopId, story);
        expect(res.status).toBe(httpStatus);
        expect(res.body.code).toBe(code);
      }
      expect(await storyRows(s.shopId)).toBe(1);
      expect((await childRows(s.shopId)).versions).toBe(1);
      expect(await t.outbox(story)).toHaveLength(0);
    },
  );

  it('S27 AS-93: a shop that was purged is 404 shop_not_found', async () => {
    const s = await t.seller({ status: 'DELETED' });
    const story = await plantPublished(s);
    for (const route of routes) {
      const res = await call(route, s.auth, s.shopId, story);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('shop_not_found');
    }
    expect(await storyRows(s.shopId)).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------ AS-94

  it('S27 AS-94: the 121st write of a minute is 429 with Retry-After, another shop and the reads are not limited, and the window reopens', async () => {
    const s = await t.seller();
    const other = await t.seller();
    const story = await t.createStory(s);
    const del = () =>
      t.del(s, `/api/shops/${s.shopId}/stories/${story.id}/schedule`);
    // the create above was the first of the 120; each of these is a 409 not_scheduled and still counts
    for (let i = 0; i < 118; i++) expect((await del()).status).toBe(409);
    const last = await del();
    expect(last.status).toBe(409);
    const refused = await del();
    expect(refused.status).toBe(429);
    expect(refused.headers['content-type']).toMatch(
      /application\/problem\+json/,
    );
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.body.code).toBe('rate_limited');
    await t.createStory(other);
    await t.get(s, `/api/shops/${s.shopId}/stories`).expect(200);
    await t.get(s, `/api/shops/${s.shopId}/stories/${story.id}`).expect(200);
    await t.advance(61_000);
    expect((await del()).status).toBe(409);
  });

  it('S27 AS-94: a limiter that cannot answer refuses the write with 503 instead of allowing it', async () => {
    const s = await t.seller();
    const redis = t.app.get(RedisService);
    const spies = [
      jest
        .spyOn(redis.client, 'evalsha')
        .mockRejectedValue(new Error('store down')),
      jest
        .spyOn(redis.client, 'eval')
        .mockRejectedValue(new Error('store down')),
    ];
    try {
      const res = await t.post(s, `/api/shops/${s.shopId}/stories`, {
        slug: 'while-down',
      });
      expect(res.status).toBe(503);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(await storyRows(s.shopId)).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------ AS-95

  it('S27 AS-95: every error of the capability is application/problem+json', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    const answers = [
      await t.http().get(`/api/shops/${s.shopId}/stories`), // 401
      await t.post(s, `/api/shops/${s.shopId}/stories`, { slug: 'Bad' }), // 400
      await t.get(s, `/api/shops/${s.shopId}/stories/${uuidv7()}`), // 404
      await t.del(s, `/api/shops/${s.shopId}/stories/${story.id}/schedule`), // 409
      await t.publish(s, story.id, { expectedVersion: 0 }), // 422 no_drafts
      await t.http().get(`/api/stories/nobody/none/en`), // public 404
      await t.http().get(`/api/sitemaps/stories-abc.xml`), // 404
      await t.http().get(`/api/stories/preview`), // 404
    ];
    expect(answers.map((a) => a.status)).toEqual([
      401, 400, 404, 409, 422, 404, 404, 404,
    ]);
    for (const answer of answers)
      expect(answer.headers['content-type']).toMatch(
        /application\/problem\+json/,
      );
  });

  // ------------------------------------------------------------------------------------------------ AS-96

  it('S27 AS-96: outcomes are logged with the request, story, shop and version and never with content, tokens or secrets; metrics exist', async () => {
    const l = t;
    {
      const s = await l.seller();
      await l.syncShop(s);
      const secretTitle = 'TOP-SECRET-DRAFT-TITLE';
      const story = await l.createStory(s);
      await l
        .saveDraft(s, story.id, 'en', {
          title: secretTitle,
          blocks: [{ type: 'quote', text: 'TOP-SECRET-QUOTE' }],
        })
        .expect(200);
      await l.publish(s, story.id, { expectedVersion: 0 }).expect(200);
      await l
        .http()
        .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
        .expect(200);
      const preview = await l
        .post(s, `/api/shops/${s.shopId}/stories/${story.id}/preview-token`, {
          locale: 'en',
        })
        .expect(200);
      await l
        .http()
        .get('/api/stories/preview')
        .set('X-Preview-Token', preview.body.token)
        .expect(200);
      await deliver(
        l.invalidation,
        (await l.outbox(story.id))[0].payload as never,
      );
      await l
        .post(s, `/api/shops/${s.shopId}/stories/${story.id}/archive`)
        .expect(200);

      const lines = l
        .logLines()
        .split('\n')
        .filter((x) => x.startsWith('{'))
        .map((x) => JSON.parse(x) as Record<string, unknown>);
      const outcomes = lines.filter(
        (x) =>
          typeof x.event === 'string' && String(x.event).startsWith('story.'),
      );
      const published = outcomes.find(
        (x) =>
          x.event === 'story.publish' &&
          x.outcome === 'published' &&
          x.storyId === story.id,
      );
      expect(published).toMatchObject({
        storyId: story.id,
        shopId: s.shopId,
        version: 1,
      });
      expect(typeof published?.requestId).toBe('string');
      expect(
        outcomes.some(
          (x) => x.event === 'story.archive' && x.outcome === 'archived',
        ),
      ).toBe(true);
      expect(
        outcomes.some(
          (x) => x.event === 'story.invalidation' && x.outcome === 'purged',
        ),
      ).toBe(true);
      const text = l.logLines();
      expect(text).not.toContain(secretTitle);
      expect(text).not.toContain('TOP-SECRET-QUOTE');
      expect(text).not.toContain(preview.body.token);
      expect(text).not.toContain(REVALIDATE_SECRET);
      expect(text).not.toContain(PREVIEW_SECRET);
    }
    const counter = (name: string, labels: Record<string, string> = {}) =>
      MetricsRegistry.value(name, labels) ?? 0;
    expect(
      counter('story_publish_total', { result: 'published' }),
    ).toBeGreaterThan(0);
    expect(
      counter('story_cache_purge_total', { target: 'cdn', result: 'ok' }),
    ).toBeGreaterThan(0);
    expect(
      counter('story_cache_purge_total', {
        target: 'revalidate',
        result: 'ok',
      }),
    ).toBeGreaterThan(0);
    expect(
      counter('story_read_origin_total', { source: 'durable' }),
    ).toBeGreaterThan(0);
    expect(
      MetricsRegistry.histogramValue('story_cache_purge_lag_seconds')?.count ??
        0,
    ).toBeGreaterThan(0);
    expect(
      MetricsRegistry.labelSets('story_publish_total').every(
        (x) => Object.keys(x).join() === 'result',
      ),
    ).toBe(true);
  });

  it('S27 AS-96: a purge that completes more than 60 seconds after its event is an alert-worthy line', async () => {
    const s = await t.seller();
    await t.syncShop(s);
    const story = await t.published(s);
    const event = (await t.outbox(story.id))[0].payload as never;
    const error = jest.spyOn(Logger.prototype, 'error');
    await t.advance(61_000);
    await deliver(t.invalidation, event);
    expect(
      error.mock.calls.some(
        ([m]) =>
          String(m).includes('alert:') && String(m).includes('after the event'),
      ),
    ).toBe(true);
    error.mockRestore();
  });

  // ------------------------------------------------------------------------------------------------ AS-99

  it('S27 AS-99: content reads no Shop table or tenancy model, holds no foreign key out of the domain, and exports only its modules', async () => {
    const root = join(__dirname);
    const sources = (dir: string): string[] =>
      readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
        const rel = join(dir, entry.name);
        if (entry.isDirectory())
          return entry.name === 'testing' ? [] : sources(rel);
        return /\.ts$/.test(entry.name) &&
          !/\.(spec|e2e-spec)\.ts$/.test(entry.name)
          ? [rel]
          : [];
      });
    const files = ['.', 'api', 'application', 'domain', 'infra'].flatMap(
      (dir) =>
        dir === '.'
          ? readdirSync(root).filter(
              (f) => /\.ts$/.test(f) && !/\.(spec|e2e-spec)\.ts$/.test(f),
            )
          : sources(dir),
    );
    expect(files.length).toBeGreaterThan(30);
    const forbidden =
      /"Shop"|"ShopMembership"|"ShopDirectory"|\bShopModel\b|\bShopMembershipModel\b|\bMembershipService\b|\bProductModel\b|FROM "Product"/;
    for (const file of files) {
      const code = readFileSync(join(root, file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect({ file, hit: forbidden.exec(code)?.[0] }).toEqual({
        file,
        hit: undefined,
      });
    }
    // foreign keys of the domain's tables point inside the domain only
    const fks = await t.rows<{ from: string; to: string }>(
      `SELECT c.conrelid::regclass::text AS "from", c.confrelid::regclass::text AS "to"
         FROM pg_constraint c
        WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('"Story"', '"StoryDraft"', '"StoryVersion"', '"StoryTransition"', '"StoryShop"')`,
    );
    for (const fk of fks) expect(['"Story"']).toContain(fk.to);
    // the barrel exports Nest modules and nothing else
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('./index') as Record<string, unknown>;
    expect(
      Object.keys(barrel)
        .filter(
          (key) => !['__esModule', 'default', 'module.exports'].includes(key),
        )
        .sort(),
    ).toEqual([
      'StoriesModule',
      'StoriesProjectorModule',
      'StoriesWorkerModule',
    ]);
  });

  it('S27 AS-99: every statement on story data names the shop in its predicate, except the few that cross shops by nature', () => {
    const dir = join(__dirname, 'infra');
    const statements = readdirSync(dir)
      .filter((f) => /\.repository\.ts$|\.reader\.ts$/.test(f))
      .flatMap((f) =>
        [
          ...readFileSync(join(dir, f), 'utf8').matchAll(
            /`([^`]*?\b(?:SELECT|UPDATE|INSERT INTO|DELETE FROM)\b[^`]*?)`/gs,
          ),
        ].map(([, sql]) => ({ file: f, sql: sql.replace(/\s+/g, ' ').trim() })),
      )
      .filter(
        ({ sql }) =>
          /"Story(Draft|Version|Transition)?"/.test(sql) &&
          !/^SELECT 1/.test(sql),
      );
    expect(statements.length).toBeGreaterThan(20);
    // the shop in the predicate, or in the join that decides visibility
    const scoped =
      /"shopId"\s*=\s*(\$shopId|sh\."shopId"|s\."shopId")|sh\."shopId"\s*=|s\."shopId"\s*=\s*sh|INSERT INTO "Story\w*" \([^)]*"shopId"/;
    // by nature across shops: the due-schedule scan, the job's story→shop lookup, the sitemap's reads and `max`
    const crossShop = [
      /FROM "Story" WHERE "scheduledAt" IS NOT NULL AND "scheduledAt" <= \$now/,
      /SELECT "shopId" FROM "Story" WHERE "id" = \$storyId$/,
      /SELECT max\("sitemapPosition"\)/,
      /FROM "Story" s JOIN "StoryShop" sh ON sh\."shopId" = s\."shopId" AND sh\."slug" IS NOT NULL/,
    ];
    const missing = statements.filter(
      ({ sql }) => !scoped.test(sql) && !crossShop.some((p) => p.test(sql)),
    );
    expect(missing.map((m) => `${m.file}: ${m.sql.slice(0, 90)}`)).toEqual([]);
  });

  it('S27 AS-99: the strict table-ownership check reports no line for content', async () => {
    const root = join(__dirname, '..', '..', '..');
    const result = await ownershipCheck(root, ['--strict']);
    // the old call threw on a non-zero exit
    expect(result.status).toBe(0);
    const output = result.stdout;
    expect(
      output.split('\n').filter((line) => /\bcontent\b/i.test(line)),
    ).toEqual([]);
  }, 300_000);
});
