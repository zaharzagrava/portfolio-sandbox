import { Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ConfigRules } from '@app/common/config';
import '@app/common/config/stories-config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { InvalidationIncompleteError } from './application/cache-invalidation.service';
import {
  MAX_SIGNATURE_AGE_SECONDS,
  verifyRevalidation,
} from './domain/revalidation-signature';
import { readModelKey } from './infra/story-read-model';
import {
  deliver,
  envelope,
  shopStatusEvent,
  storyEvent,
} from './testing/events';
import {
  REVALIDATE_SECRET,
  createStoryApp,
  type Seller,
  type StoryTestApp,
} from './testing/story-client';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('Brand stories: cache-tag invalidation consumer (origin, CDN, front end)', () => {
  let t: StoryTestApp;
  beforeAll(async () => {
    t = await createStoryApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    t.cdn.reset();
    t.front.reset();
    t.config.cdnTimeoutMs = 5_000;
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const synced = async () => {
    const s = await t.seller();
    await t.syncShop(s);
    return s;
  };
  const redis = () => t.app.get(RedisService);
  const counter = (target: string, result: string) =>
    MetricsRegistry.value('story_cache_purge_total', { target, result }) ?? 0;
  const publishedEvent = async (storyId: string, index = 0) => {
    const rows = await t.outbox(storyId);
    return rows[index].payload as unknown as ReturnType<typeof storyEvent>;
  };
  const cdnTags = () =>
    t.cdn.bodies<{ tags: string[] }>().map((b) => [...b.tags]);
  const frontCalls = () =>
    t.front.requests.map((r) => ({
      headers: r.headers,
      raw: r.body,
      body: JSON.parse(r.body) as { tags: string[]; eventId: string },
    }));
  const archive = (s: Seller, storyId: string) =>
    t.post(s, `/api/shops/${s.shopId}/stories/${storyId}/archive`).expect(200);

  // ------------------------------------------------------------------------------------------------ AS-50

  it('S27 AS-50: publish, archive and a failed schedule record their event in the transaction, keyed by the story', async () => {
    const s = await synced();
    const story = await t.published(s);
    await archive(s, story.id);
    const failing = await t.createStory(s);
    await t.saveDraft(s, failing.id, 'en').expect(200);
    const when = new Date(t.clock.now().getTime() + HOUR).toISOString();
    await t
      .publish(s, failing.id, { expectedVersion: 0, at: when })
      .expect(200);
    await t.rows(`DELETE FROM "StoryDraft" WHERE "storyId" = :id`, {
      id: failing.id,
    });
    await t.advance(HOUR);
    await t.jobs.publish(
      { storyId: failing.id, scheduledAt: when },
      t.jobContext(),
    );

    const rows = await t.outbox(story.id);
    expect(rows.map((r) => r.type)).toEqual([
      'story.published',
      'story.archived',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        kind: 'event',
        topic: 'stories.events',
        aggregateId: story.id,
        status: 'pending',
      });
      expect(row.payload).toMatchObject({
        eventId: expect.any(String),
        type: row.type,
        version: 1,
        occurredAt: expect.any(String),
        aggregateId: story.id,
      });
    }
    expect((rows[1].payload as { payload: unknown }).payload).toEqual({
      storyId: story.id,
      shopId: s.shopId,
      shopSlug: s.shopSlug,
      slug: story.slug,
      version: 1,
    });
    const failed = await t.outbox(failing.id);
    expect(failed.map((r) => r.type)).toEqual(['story.schedule_failed']);
    expect(failed[0]).toMatchObject({
      topic: 'stories.events',
      aggregateId: failing.id,
    });
  });

  it('S27 AS-50: a rolled-back change leaves no event, and the message bus being down does not fail the publish', async () => {
    const s = await synced();
    const story = await t.createStory(s);
    await t.saveDraft(s, story.id, 'en').expect(200);
    await t.publish(s, story.id, { expectedVersion: 7 }).expect(409);
    expect(await t.outbox(story.id)).toHaveLength(0);
    // nothing in the request path talks to the bus: the row waits for the relay
    await t.publish(s, story.id, { expectedVersion: 0 }).expect(200);
    const rows = await t.outbox(story.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
  });

  // ------------------------------------------------------------------------------------------------ AS-51

  it('S27 AS-51: the origin entry goes first, then the CDN is purged by tag, then the front end is told with a signed call', async () => {
    const s = await synced();
    const story = await t.published(s);
    const key = readModelKey(s.shopSlug, story.slug);
    await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(200);
    // a reader re-cached the entry after the publish's own delete
    await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(200);
    const order: string[] = [];
    t.cdn.onRequest = async () => {
      order.push(`cdn(originCached=${await redis().client.exists(key)})`);
    };
    t.front.onRequest = () => {
      order.push('front');
    };
    await redis().client.set(
      key,
      (await redis().client.get(key)) ?? '{}',
      'PX',
      60_000,
    );
    expect(await redis().client.exists(key)).toBe(1);

    const event = await publishedEvent(story.id);
    await deliver(t.invalidation, event);

    expect(order).toEqual(['cdn(originCached=0)', 'front']);
    expect(t.cdn.requests).toHaveLength(1);
    expect(t.cdn.requests[0]).toMatchObject({
      method: 'POST',
      url: '/zones/zone-test/purge_cache',
    });
    expect(t.cdn.requests[0].headers.authorization).toBe('Bearer token-test');
    expect(t.cdn.bodies()).toEqual([
      { tags: [`story:${story.id}`, `shop:${s.shopId}`] },
    ]);

    const [call] = frontCalls();
    expect(call.body).toEqual({
      tags: [`story:${story.id}`, `shop:${s.shopId}`],
      eventId: event.eventId,
    });
    const timestamp = String(call.headers['x-revalidate-timestamp']);
    expect(timestamp).toBe(String(Math.floor(t.clock.nowMs() / 1_000)));
    const signature = String(call.headers['x-revalidate-signature']);
    const now = Math.floor(t.clock.nowMs() / 1_000);
    expect(
      verifyRevalidation(
        REVALIDATE_SECRET,
        timestamp,
        call.raw,
        signature,
        now,
      ),
    ).toBe(true);
    expect(
      verifyRevalidation(
        REVALIDATE_SECRET,
        timestamp,
        call.raw.replace('story:', 'stor:'),
        signature,
        now,
      ),
    ).toBe(false);
    expect(
      verifyRevalidation(
        REVALIDATE_SECRET,
        timestamp,
        call.raw,
        signature,
        now + MAX_SIGNATURE_AGE_SECONDS + 1,
      ),
    ).toBe(false);
    expect(
      verifyRevalidation(
        'another-secret-0123456789abcdef',
        timestamp,
        call.raw,
        signature,
        now,
      ),
    ).toBe(false);
  });

  // ------------------------------------------------------------------------------------------------ AS-52

  it('S27 AS-52: a batch of 100 events for 40 stories of 3 shops purges 43 distinct tags once each, 30 at most per call', async () => {
    const shops = [uuidv7(), uuidv7(), uuidv7()];
    const stories = Array.from({ length: 40 }, () => uuidv7());
    const events = Array.from({ length: 100 }, (_, i) => {
      const storyId = stories[i % 40];
      const shopId = shops[(i % 40) % 3];
      return storyEvent(i % 5 === 0 ? 'story.archived' : 'story.published', {
        storyId,
        shopId,
        shopSlug: `shop-${shopId.slice(-6)}`,
        slug: `story-${i % 40}`,
        version: 1 + Math.floor(i / 40),
        locales: ['en'],
      });
    });
    await deliver(t.invalidation, events);
    const calls = cdnTags();
    expect(calls.map((c) => c.length)).toEqual([30, 13]);
    const all = calls.flat();
    expect(new Set(all).size).toBe(43);
    expect(all).toHaveLength(43);
    expect(frontCalls().map((c) => c.body.tags.length)).toEqual([30, 13]);
    expect(
      frontCalls()
        .flatMap((c) => c.body.tags)
        .sort(),
    ).toEqual([...all].sort());
  });

  // ------------------------------------------------------------------------------------------------ AS-53

  it('S27 AS-53: an event delivered again, also twenty times at once, purges and calls the front end once', async () => {
    const s = await synced();
    const story = await t.published(s);
    const event = await publishedEvent(story.id);
    await deliver(t.invalidation, event);
    await deliver(t.invalidation, event);
    expect(t.cdn.requests).toHaveLength(1);
    expect(t.front.requests).toHaveLength(1);

    const second = await t.published(s);
    const other = await publishedEvent(second.id);
    await Promise.all(
      Array.from({ length: 20 }, () => deliver(t.invalidation, other)),
    );
    expect(t.cdn.requests).toHaveLength(2);
    expect(t.front.requests).toHaveLength(2);
  });

  // ------------------------------------------------------------------------------------------------ AS-54

  it('S27 AS-54: a busy CDN is retried inside the call; the front end is called once the purge succeeded', async () => {
    const s = await synced();
    const story = await t.published(s);
    const retriesBefore = counter('cdn', 'retry');
    t.cdn.script = [503, 429];
    await deliver(t.invalidation, await publishedEvent(story.id));
    expect(t.cdn.requests).toHaveLength(3);
    expect(t.front.requests).toHaveLength(1);
    expect(counter('cdn', 'retry')).toBe(retriesBefore + 2);
  });

  it('S27 AS-54: a CDN that keeps failing is tried 4 times (3 retries), the front end is still called, and the event is redelivered whole', async () => {
    const s = await synced();
    const story = await t.published(s);
    const event = await publishedEvent(story.id);
    t.cdn.defaultStatus = 502;
    await expect(deliver(t.invalidation, event)).rejects.toBeInstanceOf(
      InvalidationIncompleteError,
    );
    expect(t.cdn.requests).toHaveLength(4);
    expect(t.front.requests).toHaveLength(1);
    expect(t.invalidation.attempts).toBe(8);

    t.cdn.defaultStatus = 200;
    await deliver(t.invalidation, event);
    expect(t.cdn.requests).toHaveLength(5);
    expect(t.front.requests).toHaveLength(2); // the redelivery repeats what is idempotent
    await deliver(t.invalidation, event);
    expect(t.cdn.requests).toHaveLength(5); // and now it is recorded as processed
  });

  it('S27 AS-54: a CDN that does not answer within its timeout is a failure too', async () => {
    const s = await synced();
    const story = await t.published(s);
    t.config.cdnTimeoutMs = 150;
    t.cdn.delayMs = 400;
    await expect(
      deliver(t.invalidation, await publishedEvent(story.id)),
    ).rejects.toBeInstanceOf(InvalidationIncompleteError);
    expect(t.cdn.requests).toHaveLength(4);
    expect(t.front.requests).toHaveLength(1);
  });

  it.each([401, 403, 404])(
    'S27 AS-54: a CDN %s is permanent: one try, a dead letter at once, an alert-worthy line, the front end still called',
    async (status) => {
      const s = await synced();
      const story = await t.published(s);
      const error = jest.spyOn(Logger.prototype, 'error');
      t.cdn.defaultStatus = status;
      const result = await deliver(
        t.invalidation,
        await publishedEvent(story.id),
      );
      expect(result.delivered).toBe(false);
      expect(t.cdn.requests).toHaveLength(1);
      expect(t.front.requests).toHaveLength(1);
      expect(
        error.mock.calls.some(([message]) =>
          String(message).includes('alert:'),
        ),
      ).toBe(true);
    },
  );

  it('S27 AS-54: a failing front end fails the event but the CDN purge was attempted first', async () => {
    const s = await synced();
    const story = await t.published(s);
    t.front.defaultStatus = 500;
    await expect(
      deliver(t.invalidation, await publishedEvent(story.id)),
    ).rejects.toBeInstanceOf(InvalidationIncompleteError);
    expect(t.cdn.requests).toHaveLength(1);
    expect(t.front.requests).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------------------------ AS-55

  it.each([
    [
      'a missing storyId',
      {
        shopId: uuidv7(),
        shopSlug: 'x',
        slug: 'x',
        version: 1,
        locales: ['en'],
      },
      1,
    ],
    [
      'a missing shopId',
      {
        storyId: uuidv7(),
        shopSlug: 'x',
        slug: 'x',
        version: 1,
        locales: ['en'],
      },
      1,
    ],
    [
      'a wrong type',
      {
        storyId: 12,
        shopId: uuidv7(),
        shopSlug: 'x',
        slug: 'x',
        version: 1,
        locales: ['en'],
      },
      1,
    ],
    [
      'an unknown version',
      {
        storyId: uuidv7(),
        shopId: uuidv7(),
        shopSlug: 'x',
        slug: 'x',
        version: 1,
        locales: ['en'],
      },
      9,
    ],
  ])(
    'S27 AS-55: %s is dead-lettered and touches nothing',
    async (_name, payload, version) => {
      const s = await synced();
      const story = await t.published(s);
      await t
        .http()
        .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
        .expect(200);
      const key = readModelKey(s.shopSlug, story.slug);
      const result = await deliver(
        t.invalidation,
        envelope('story.published', 'stories', uuidv7(), payload, 1, version),
      );
      expect(result.delivered).toBe(false);
      expect(t.cdn.requests).toHaveLength(0);
      expect(t.front.requests).toHaveLength(0);
      expect(await redis().client.exists(key)).toBe(1);
    },
  );

  // ------------------------------------------------------------------------------------------------ AS-56

  it('S27 AS-56: events out of order each purge their tags, and the public answer follows the durable state', async () => {
    const s = await synced();
    const story = await t.published(s);
    const publishedE = await publishedEvent(story.id);
    await archive(s, story.id);
    const archivedE = (await t.outbox(story.id))[1]
      .payload as unknown as ReturnType<typeof storyEvent>;
    await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(404);

    await deliver(t.invalidation, archivedE);
    await deliver(t.invalidation, publishedE); // arrives late
    expect(cdnTags()).toEqual([
      [`story:${story.id}`, `shop:${s.shopId}`],
      [`story:${story.id}`, `shop:${s.shopId}`],
    ]);
    await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(404);
  });

  // ------------------------------------------------------------------------------------------------ AS-57

  it('S27 AS-57: an old version left in the origin cache by a racing reader is cleared before the purge', async () => {
    const s = await synced();
    const story = await t.published(s);
    const url = `/api/stories/${s.shopSlug}/${story.slug}/en`;
    await t.http().get(url).expect(200);
    const key = readModelKey(s.shopSlug, story.slug);
    const staleEntry = (await redis().client.get(key)) as string;
    await t.saveDraft(s, story.id, 'en', { title: 'Second' }, 1).expect(200);
    await t.publish(s, story.id, { expectedVersion: 1 }).expect(200);
    // the slow reader writes its pre-publish result after the commit
    await redis().client.set(key, staleEntry, 'PX', 60_000);
    expect((await t.http().get(url).expect(200)).body.version).toBe(1);

    await deliver(t.invalidation, await publishedEvent(story.id, 1));
    const fresh = await t.http().get(url).expect(200);
    expect(fresh.body).toMatchObject({ version: 2, title: 'Second' });
  });

  // ------------------------------------------------------------------------------------------------ AS-58

  it('S27 AS-58: a suspended shop’s stories answer 404 and are purged; reinstating brings them back; duplicates change nothing', async () => {
    const s = await synced();
    const story = await t.published(s);
    const url = `/api/stories/${s.shopSlug}/${story.slug}/en`;
    await t.http().get(url).expect(200);
    const key = readModelKey(s.shopSlug, story.slug);
    expect(await redis().client.exists(key)).toBe(1);

    const suspend = shopStatusEvent(s.shopId, 'ACTIVE', 'SUSPENDED', 2);
    await deliver(t.shopCopy, suspend);
    expect(await redis().client.exists(key)).toBe(0);
    await t.http().get(url).expect(404);
    expect(cdnTags().flat()).toContain(`shop:${s.shopId}`);
    expect(frontCalls().flatMap((c) => c.body.tags)).toContain(
      `shop:${s.shopId}`,
    );

    const calls = t.cdn.requests.length;
    await deliver(t.shopCopy, suspend); // the same event again
    await deliver(
      t.shopCopy,
      shopStatusEvent(s.shopId, 'SUSPENDED', 'ACTIVE', 1),
    ); // older by version
    expect(t.cdn.requests).toHaveLength(calls);
    await t.http().get(url).expect(404);

    await deliver(
      t.shopCopy,
      shopStatusEvent(s.shopId, 'SUSPENDED', 'ACTIVE', 3),
    );
    expect(t.cdn.requests).toHaveLength(calls + 1);
    await t.http().get(url).expect(200);
  });

  it('S27 AS-58: a failed purge for a suspension is repeated when the event is redelivered', async () => {
    const s = await synced();
    const story = await t.published(s);
    await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(200);
    const suspend = shopStatusEvent(s.shopId, 'ACTIVE', 'SUSPENDED', 2);
    t.cdn.defaultStatus = 503;
    await expect(deliver(t.shopCopy, suspend)).rejects.toBeDefined();
    t.cdn.reset();
    await deliver(t.shopCopy, suspend);
    expect(cdnTags().flat()).toContain(`shop:${s.shopId}`);
  });

  // ------------------------------------------------------------------------------------------------ AS-59

  it('S27 AS-59: without CDN or revalidation credentials outside production the calls are logged and nothing leaves the process', async () => {
    const s = await synced();
    const story = await t.published(s);
    const event = await publishedEvent(story.id);
    const log = jest.spyOn(Logger.prototype, 'log');
    const saved = {
      cdn_zone: t.settings.get('cdn_zone'),
      cdn_token: t.settings.get('cdn_token'),
      revalidate_secret: t.settings.get('revalidate_secret'),
    };
    t.settings.set('cdn_zone', undefined);
    t.settings.set('cdn_token', undefined);
    t.settings.set('revalidate_secret', undefined);
    try {
      await deliver(t.invalidation, event);
    } finally {
      for (const [key, value] of Object.entries(saved))
        t.settings.set(key as 'cdn_zone', value);
    }
    expect(t.cdn.requests).toHaveLength(0);
    expect(t.front.requests).toHaveLength(0);
    const lines = log.mock.calls.map(([m]) => String(m));
    expect(lines.some((l) => l.includes(`purge tags: story:${story.id}`))).toBe(
      true,
    );
    expect(
      lines.some((l) => l.includes(`revalidate tags: story:${story.id}`)),
    ).toBe(true);
  });

  it('S27 AS-59: production refuses to start without the settings, naming each missing key and no value', () => {
    const complete: Record<string, unknown> = {
      story_preview_secret: 'p'.repeat(40),
      revalidate_secret: 'r'.repeat(40),
      revalidate_url: 'https://front.example/api/revalidate',
      cdn_zone: 'zone',
      cdn_token: 'token-value-that-must-not-leak',
      front_host: 'https://front.example',
      backend_host: 'https://api.example',
      jwt_secret: 'j'.repeat(40),
    };
    const run = (values: Record<string, unknown>) =>
      ConfigRules.validate(values, { production: true }).filter((m) =>
        m.startsWith('[content]'),
      );
    expect(run(complete)).toEqual([]);
    for (const key of [
      'story_preview_secret',
      'revalidate_secret',
      'revalidate_url',
      'cdn_zone',
      'cdn_token',
      'front_host',
      'backend_host',
    ]) {
      const messages = run({ ...complete, [key]: undefined });
      expect(messages).toEqual([`[content] ${key} is required in production`]);
    }
    expect(
      JSON.stringify(run({ ...complete, cdn_zone: undefined })),
    ).not.toContain('token-value-that-must-not-leak');
    expect(
      run({ ...complete, story_preview_secret: complete.jwt_secret }),
    ).toEqual(['[content] story_preview_secret must differ from jwt_secret']);
    expect(
      ConfigRules.validate(
        { ...complete, cdn_zone: undefined },
        { production: false },
      ).filter((m) => m.startsWith('[content]')),
    ).toEqual([]);
  });
});
