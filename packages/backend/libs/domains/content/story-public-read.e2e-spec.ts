import { Logger } from '@nestjs/common';
import { publicStorySchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { SequelizePublishedStoryReader } from './infra/published-story.reader';
import { readModelKey } from './infra/story-read-model';
import { deliver, shopStatusEvent } from './testing/events';
import {
  FRONT_HOST,
  createStoryApp,
  expectContract,
  type Seller,
  type StoryTestApp,
} from './testing/story-client';

describe('Brand stories: public read, edge cache headers, conditional requests and locales', () => {
  let t: StoryTestApp;
  beforeAll(async () => {
    t = await createStoryApp();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const get = (s: Seller, slug: string, locale = 'en') =>
    t.http().get(`/api/stories/${s.shopSlug}/${slug}/${locale}`);
  const syncedSeller = async () => {
    const s = await t.seller();
    await t.syncShop(s);
    return s;
  };
  const url = (s: Seller, slug: string, locale: string) =>
    `${FRONT_HOST}/${locale}/brands/${s.shopSlug}/stories/${slug}`;

  // ------------------------------------------------------------------------------------------------ AS-25

  it('S27 AS-25: a published story is served anonymously with the edge cache contract', async () => {
    const s = await syncedSeller();
    const product = await t.product(s);
    const story = await t.createStory(s, 'inside-iphone-18');
    await t
      .saveDraft(s, story.id, 'en', {
        title: 'Inside',
        blocks: [
          { type: 'product', productId: product.id },
          { type: 'heading', level: 2, text: 'Hi' },
        ],
      })
      .expect(200);
    await t.publish(s, story.id, { expectedVersion: 0 }).expect(200);

    const res = await get(s, 'inside-iphone-18').expect(200);
    const body = expectContract(publicStorySchema, res.body);
    expect(body).toMatchObject({
      id: story.id,
      shopId: s.shopId,
      slug: 'inside-iphone-18',
      version: 1,
      locale: 'en',
      title: 'Inside',
      preview: false,
      publishedAt: t.clock.now().toISOString(),
    });
    expect(body.blocks[0]).toEqual({ type: 'product', productId: product.id });
    expect(res.headers['cache-control']).toBe(
      'public, s-maxage=300, stale-while-revalidate=86400',
    );
    expect(res.headers['cache-tag']).toBe(`story:${story.id},shop:${s.shopId}`);
    expect(res.headers.etag).toBe(`"${story.id}-v1-en"`);
    expect(res.headers['content-language']).toBe('en');
    expect(res.headers.vary ?? '').not.toMatch(/accept-language/i);
    expect(res.headers['set-cookie']).toBeUndefined();

    const head = await t
      .http()
      .head(`/api/stories/${s.shopSlug}/inside-iphone-18/en`)
      .expect(200);
    expect(head.text ?? '').toBe('');
    for (const name of [
      'cache-control',
      'cache-tag',
      'etag',
      'content-language',
    ])
      expect(head.headers[name]).toBe(res.headers[name]);
  });

  // ------------------------------------------------------------------------------------------------ AS-26

  it.each([
    ['the same tag', (etag: string) => etag],
    ['one of several', (etag: string) => `"nope", ${etag} , "other"`],
    ['a weak tag', (etag: string) => `W/${etag}`],
    ['a star', () => '*'],
  ])(
    'S27 AS-26: If-None-Match with %s answers 304 with the validators and no body',
    async (_name, header) => {
      const s = await syncedSeller();
      const story = await t.published(s);
      const first = await get(s, story.slug).expect(200);
      const res = await get(s, story.slug)
        .set('If-None-Match', header(first.headers.etag))
        .expect(304);
      expect(res.text).toBe('');
      expect(res.headers.etag).toBe(first.headers.etag);
      expect(res.headers['cache-control']).toBe(first.headers['cache-control']);
      expect(res.headers['cache-tag']).toBe(first.headers['cache-tag']);
    },
  );

  it('S27 AS-26: another tag is a 200, and a republish makes the old tag stale', async () => {
    const s = await syncedSeller();
    const story = await t.published(s);
    const first = await get(s, story.slug).expect(200);
    await get(s, story.slug)
      .set('If-None-Match', '"something-else"')
      .expect(200);
    await t.saveDraft(s, story.id, 'en', { title: 'v2' }, 1).expect(200);
    await t.publish(s, story.id, { expectedVersion: 1 }).expect(200);
    const second = await get(s, story.slug)
      .set('If-None-Match', first.headers.etag)
      .expect(200);
    expect(second.headers.etag).not.toBe(first.headers.etag);
    expect(second.headers.etag).toBe(`"${story.id}-v2-en"`);
  });

  // ------------------------------------------------------------------------------------------------ AS-27

  it.each([
    ['uk', 'uk'],
    ['UK', 'uk'],
    ['uk-UA', 'uk'],
    ['uk-ua', 'uk'],
    ['fr', 'en'],
    ['en-GB', 'en'],
    ['pt', 'en'],
    ['pt-BR', 'pt-BR'],
    ['pt-br', 'pt-BR'],
  ])('S27 AS-27: locale %s is served as %s', async (requested, served) => {
    const s = await syncedSeller();
    const story = await t.published(s, { locales: ['en', 'uk', 'pt-BR'] });
    const res = await get(s, story.slug, requested)
      .set('Accept-Language', 'de')
      .expect(200);
    expect(res.body.locale).toBe(served);
    expect(res.headers['content-language']).toBe(served);
    expect(res.headers.etag).toBe(`"${story.id}-v1-${served}"`);
  });

  it.each(['EN_us', 'e', 'english', 'en-USA', 'u1'])(
    'S27 AS-27: the malformed locale %s is 400 validation_failed',
    async (locale) => {
      const s = await syncedSeller();
      const story = await t.published(s);
      const res = await get(s, story.slug, locale).expect(400);
      expect(res.body.code).toBe('validation_failed');
    },
  );

  // ------------------------------------------------------------------------------------------------ AS-28

  it('S27 AS-28: canonical and alternates name every locale and x-default, the canonical being the one that owns the content', async () => {
    const s = await syncedSeller();
    const story = await t.published(s, {
      slug: 'inside-iphone-18',
      locales: ['en', 'uk'],
    });
    const alternates = [
      { locale: 'en', href: url(s, story.slug, 'en') },
      { locale: 'uk', href: url(s, story.slug, 'uk') },
      { locale: 'x-default', href: url(s, story.slug, 'en') },
    ];
    for (const locale of ['en', 'uk']) {
      const res = await get(s, story.slug, locale).expect(200);
      expect(res.body.alternates).toEqual(alternates);
      expect(res.body.canonical).toBe(url(s, story.slug, locale));
    }
    const fallback = await get(s, story.slug, 'fr').expect(200);
    expect(fallback.body.alternates).toEqual(alternates);
    expect(fallback.body.canonical).toBe(url(s, story.slug, 'en'));
    expect(fallback.body.preview).toBe(false);
  });

  // ------------------------------------------------------------------------------------------------ AS-29

  it('S27 AS-29: every story that is not public is the same cacheable 404', async () => {
    const s = await syncedSeller();
    const draftOnly = await t.createStory(s);
    await t.saveDraft(s, draftOnly.id, 'en').expect(200);
    const archived = await t.published(s);
    await t
      .post(s, `/api/shops/${s.shopId}/stories/${archived.id}/archive`)
      .expect(200);
    const suspendedShop = await syncedSeller();
    const live = await t.published(suspendedShop);
    await get(suspendedShop, live.slug).expect(200);
    await deliver(
      t.shopCopy,
      shopStatusEvent(suspendedShop.shopId, 'ACTIVE', 'SUSPENDED', 2),
    );

    const answers = await Promise.all([
      t.http().get(`/api/stories/no-such-shop-xyz/${draftOnly.slug}/en`),
      get(s, 'no-such-story'),
      get(s, draftOnly.slug),
      get(s, archived.slug),
      get(suspendedShop, live.slug),
    ]);
    const shape = (r: (typeof answers)[number]) => ({
      status: r.status,
      type: r.body.type,
      title: r.body.title,
      detail: r.body.detail,
      code: r.body.code,
    });
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(shape(answer)).toEqual(shape(answers[0]));
      expect(answer.body.code).toBe('story_not_found');
      expect(answer.headers['cache-control']).toBe('public, s-maxage=10');
      expect(answer.headers['cache-tag']).toBeUndefined();
    }
  });

  // ------------------------------------------------------------------------------------------------ AS-30

  it('S27 AS-30: fifty readers on a cold key make one durable read; the entry holds every locale and expires within 60 s', async () => {
    const s = await syncedSeller();
    const story = await t.published(s, { locales: ['en', 'uk'] });
    const redis = t.app.get(RedisService);
    const key = readModelKey(s.shopSlug, story.slug);
    await redis.client.del(key);
    const spy = jest.spyOn(SequelizePublishedStoryReader.prototype, 'load');

    const results = await Promise.all(
      Array.from({ length: 50 }, () => get(s, story.slug)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    const stored = JSON.parse((await redis.client.get(key)) as string) as {
      v: { locales: Record<string, unknown> };
    };
    expect(Object.keys(stored.v.locales).sort()).toEqual(['en', 'uk']);
    const ttl = await redis.client.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);

    await get(s, story.slug).expect(200);
    await get(s, story.slug, 'uk').expect(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('S27 AS-30: a wiped cache is filled again from the durable store', async () => {
    const s = await syncedSeller();
    const story = await t.published(s);
    await get(s, story.slug).expect(200);
    const redis = t.app.get(RedisService);
    await redis.client.del(readModelKey(s.shopSlug, story.slug));
    const spy = jest.spyOn(SequelizePublishedStoryReader.prototype, 'load');
    await get(s, story.slug).expect(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------------------------------------ AS-31

  it('S27 AS-31: a locale dropped from a later version is served by fallback and leaves the alternates', async () => {
    const s = await syncedSeller();
    const story = await t.published(s, { locales: ['en', 'uk'] });
    expect((await get(s, story.slug, 'uk').expect(200)).body.locale).toBe('uk');
    await t
      .del(
        s,
        `/api/shops/${s.shopId}/stories/${story.id}/drafts/uk?expectedRevision=1`,
      )
      .expect(204);
    await t.saveDraft(s, story.id, 'en', { title: 'v2' }, 1).expect(200);
    await t.publish(s, story.id, { expectedVersion: 1 }).expect(200);
    const res = await get(s, story.slug, 'uk').expect(200);
    expect(res.body.locale).toBe('en');
    expect(res.body.version).toBe(2);
    expect(
      res.body.alternates.map((a: { locale: string }) => a.locale),
    ).toEqual(['en', 'x-default']);
    expect(res.body.canonical).toBe(url(s, story.slug, 'en'));
  });

  // ------------------------------------------------------------------------------------------------ AS-30 (cache outage; last, it trips the cache's breaker)

  it('S27 AS-30: an unreachable cache still answers 200 from the durable store, counts the fallback and raises an alert-worthy line', async () => {
    const s = await syncedSeller();
    const story = await t.published(s);
    const redis = t.app.get(RedisService);
    const warn = jest.spyOn(Logger.prototype, 'warn');
    jest
      .spyOn(redis.client, 'get')
      .mockRejectedValue(new Error('ECONNREFUSED redis'));
    const before =
      MetricsRegistry.value('story_read_origin_total', {
        source: 'fallback',
      }) ?? 0;
    const res = await get(s, story.slug).expect(200);
    expect(res.body.slug).toBe(story.slug);
    expect(
      MetricsRegistry.value('story_read_origin_total', {
        source: 'fallback',
      }) ?? 0,
    ).toBeGreaterThan(before);
    expect(
      warn.mock.calls.some(([message]) => String(message).includes('alert:')),
    ).toBe(true);
  });
});
