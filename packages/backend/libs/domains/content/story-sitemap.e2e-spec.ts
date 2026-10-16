import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { STORY_DEFAULTS } from './domain/limits';
import { SequelizeSitemapReader } from './infra/sitemap.reader';
import { deliver, shopStatusEvent } from './testing/events';
import {
  BACKEND_HOST,
  FRONT_HOST,
  createStoryApp,
  type Seller,
  type StoryTestApp,
} from './testing/story-client';
import { assertWellFormedXml, parseIndex, parseUrlset } from './testing/xml';

describe('Brand stories: streamed sitemap index and child sitemaps', () => {
  let t: StoryTestApp;
  beforeAll(async () => {
    t = await createStoryApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    // positions are global and never reused: every case starts from an empty table and a fresh sequence
    await t.rows(`DELETE FROM "StoryTransition"`);
    await t.rows(`DELETE FROM "Story"`);
    await t.rows(`ALTER SEQUENCE story_sitemap_position_seq RESTART WITH 1`);
    t.config.sitemapPageCapacity = STORY_DEFAULTS.sitemapPageCapacity;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    t.settings.set('front_host', FRONT_HOST);
  });

  const index = () => t.http().get('/api/sitemaps/stories.xml');
  const page = (n: number | string) =>
    t.http().get(`/api/sitemaps/stories-${n}.xml`);
  const synced = async () => {
    const s = await t.seller();
    await t.syncShop(s);
    return s;
  };
  const slugsOf = (xml: string) => [
    ...new Set(
      parseUrlset(xml).map((u) => /stories\/([^/]+)$/.exec(u.loc)?.[1] ?? ''),
    ),
  ];
  const queries = async <T>(work: () => Promise<T>) => {
    const seen: string[] = [];
    const options = (t.db as unknown as { options: { logging: unknown } })
      .options;
    const previous = options.logging;
    options.logging = (sql: string) => seen.push(sql);
    try {
      return { result: await work(), seen };
    } finally {
      options.logging = previous;
    }
  };

  // ------------------------------------------------------------------------------------------------ AS-70

  it('S27 AS-70: the index lists one child per page of the highest position, never counting', async () => {
    t.config.sitemapPageCapacity = 2_500;
    const s = await synced();
    const story = await t.published(s);
    await t.rows(
      `UPDATE "Story" SET "sitemapPosition" = 5001 WHERE "id" = :id`,
      { id: story.id },
    );
    const { result, seen } = await queries(() => index());
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toMatch(/^application\/xml/);
    expect(result.headers['cache-control']).toBe('public, s-maxage=3600');
    assertWellFormedXml(result.text);
    expect(parseIndex(result.text)).toEqual(
      [0, 1, 2].map((i) => `${BACKEND_HOST}/api/sitemaps/stories-${i}.xml`),
    );
    expect(
      seen.filter((q) => /count\s*\(/i.test(q) && /"Story"/.test(q)),
    ).toEqual([]);
    expect(seen.filter((q) => /\boffset\b/i.test(q))).toEqual([]);
  });

  it('S27 AS-70: with no published story the index lists one empty child', async () => {
    const res = await index().expect(200);
    expect(parseIndex(res.text)).toEqual([
      `${BACKEND_HOST}/api/sitemaps/stories-0.xml`,
    ]);
    const child = await page(0).expect(200);
    assertWellFormedXml(child.text);
    expect(parseUrlset(child.text)).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------------ AS-71

  it('S27 AS-71: a child lists a url per story and locale with lastmod and every alternate, and leaves out what is not public', async () => {
    const s = await synced();
    const one = await t.published(s, { slug: 'one-locale' });
    const two = await t.published(s, {
      slug: 'two-locales',
      locales: ['en', 'uk'],
    });
    const many = await t.published(s, {
      slug: 'twenty-locales',
      locales: Array.from({ length: 20 }, (_, i) =>
        i === 0 ? 'en' : `a${String.fromCharCode(97 + i)}`,
      ),
    });
    const draftOnly = await t.createStory(s, 'only-a-draft');
    await t.saveDraft(s, draftOnly.id, 'en').expect(200);
    const archived = await t.published(s, { slug: 'taken-down' });
    await t
      .post(s, `/api/shops/${s.shopId}/stories/${archived.id}/archive`)
      .expect(200);
    const hidden = await synced();
    await t.published(hidden, { slug: 'hidden-story' });
    await deliver(
      t.shopCopy,
      shopStatusEvent(hidden.shopId, 'ACTIVE', 'SUSPENDED', 2),
    );

    const res = await page(0).expect(200);
    assertWellFormedXml(res.text);
    const urls = parseUrlset(res.text);
    expect(urls).toHaveLength(1 + 2 + 20);
    expect(slugsOf(res.text).sort()).toEqual(
      [one.slug, many.slug, two.slug].sort(),
    );
    const uk = urls.find(
      (u) =>
        u.loc === `${FRONT_HOST}/uk/brands/${s.shopSlug}/stories/two-locales`,
    )!;
    expect(uk.lastmod).toBe(t.clock.now().toISOString());
    expect(uk.alternates).toEqual([
      {
        hreflang: 'en',
        href: `${FRONT_HOST}/en/brands/${s.shopSlug}/stories/two-locales`,
      },
      {
        hreflang: 'uk',
        href: `${FRONT_HOST}/uk/brands/${s.shopSlug}/stories/two-locales`,
      },
      {
        hreflang: 'x-default',
        href: `${FRONT_HOST}/en/brands/${s.shopSlug}/stories/two-locales`,
      },
    ]);
    const twenty = urls.filter((u) => u.loc.endsWith('/twenty-locales'));
    expect(twenty).toHaveLength(20);
    expect(twenty[0].alternates).toHaveLength(21);
    expect(urls.length).toBeLessThanOrEqual(50_000);
  });

  it('S27 AS-71: markup characters in a host never break the document', async () => {
    const s = await synced();
    await t.published(s);
    t.settings.set('front_host', `https://shop.example.test/?a=1&b="2"<'>`);
    const res = await page(0).expect(200);
    assertWellFormedXml(res.text);
    expect(res.text).toContain('&amp;b=&quot;2&quot;&lt;&apos;&gt;');
    expect(parseUrlset(res.text)[0].loc).toContain(`?a=1&b="2"<'>`);
  });

  // ------------------------------------------------------------------------------------------------ AS-72

  it('S27 AS-72: a story keeps its page after earlier ones are archived and later ones published', async () => {
    t.config.sitemapPageCapacity = 2;
    const s = await synced();
    const stories: { id: string; slug: string }[] = [];
    for (let i = 1; i <= 5; i++)
      stories.push(await t.published(s, { slug: `story-${i}` }));
    const positions = await t.rows<{ slug: string; sitemapPosition: string }>(
      `SELECT "slug", "sitemapPosition" FROM "Story" ORDER BY "sitemapPosition"`,
    );
    expect(positions.map((p) => Number(p.sitemapPosition))).toEqual([
      1, 2, 3, 4, 5,
    ]);

    await t
      .post(s, `/api/shops/${s.shopId}/stories/${stories[0].id}/archive`)
      .expect(200);
    stories.push(await t.published(s, { slug: 'story-6' }));
    expect(parseIndex((await index().expect(200)).text)).toHaveLength(3);
    expect(slugsOf((await page(0).expect(200)).text)).toEqual(['story-2']);
    expect(slugsOf((await page(1).expect(200)).text)).toEqual([
      'story-3',
      'story-4',
    ]);
    expect(slugsOf((await page(2).expect(200)).text)).toEqual([
      'story-5',
      'story-6',
    ]);

    // republishing the archived story gives it its old place back
    await t.publish(s, stories[0].id, { expectedVersion: 1 }).expect(200);
    expect(slugsOf((await page(0).expect(200)).text)).toEqual([
      'story-1',
      'story-2',
    ]);
  });

  // ------------------------------------------------------------------------------------------------ AS-73

  it.each(['abc', '-1', '1.5', '99999999999999999999', '007', '1e3'])(
    'S27 AS-73: stories-%s.xml is 404 not_found',
    async (name) => {
      const s = await synced();
      await t.published(s);
      const res = await page(name).expect(404);
      expect(res.body.code).toBe('not_found');
    },
  );

  it('S27 AS-73: a page beyond the last is 404, a valid page with nothing public is an empty 200', async () => {
    const s = await synced();
    const story = await t.published(s);
    await page(1).expect(404);
    await t
      .post(s, `/api/shops/${s.shopId}/stories/${story.id}/archive`)
      .expect(200);
    const empty = await page(0).expect(200);
    assertWellFormedXml(empty.text);
    expect(parseUrlset(empty.text)).toEqual([]);
    expect(empty.text).toContain('</urlset>');
  });

  // ------------------------------------------------------------------------------------------------ AS-74, AS-75

  /** Published stories straight into the tables (test code may touch every table, IX.6); `locales` per story. */
  const bulk = async (s: Seller, count: number, locales = 1) => {
    await t.rows(
      `WITH made AS (
         INSERT INTO "Story" ("id", "shopId", "slug", "defaultLocale", "status", "publishedVersion", "publishedAt", "sitemapPosition", "createdAt")
         SELECT uuidv7(), :shopId, 'bulk-' || g, 'en', 'PUBLISHED', 1, now(), nextval('story_sitemap_position_seq'), now()
           FROM generate_series(1, :count) g RETURNING "id", "shopId")
       INSERT INTO "StoryVersion" ("storyId", "shopId", "version", "locale", "title", "blocks", "seo", "createdAt", "publishedAt")
       SELECT made."id", made."shopId", 1, CASE WHEN l = 1 THEN 'en' ELSE 'a' || chr(96 + l) END, 'T', '[]'::jsonb, '{}'::jsonb, now(), now()
         FROM made CROSS JOIN generate_series(1, :locales) l`,
      { shopId: s.shopId, count, locales },
    );
  };
  const port = () => (t.app.getHttpServer().address() as AddressInfo).port;

  it('S27 AS-74: a 5,000-story page is read in batches of at most 1,000 by position, never with an offset', async () => {
    t.config.sitemapPageCapacity = 5_000;
    const s = await synced();
    await bulk(s, 5_000);
    const spy = jest.spyOn(SequelizeSitemapReader.prototype, 'readBatch');
    const { result, seen } = await queries(() => page(0));
    expect(result.status).toBe(200);
    assertWellFormedXml(result.text);
    expect(parseUrlset(result.text)).toHaveLength(5_000);
    const calls = spy.mock.calls.map(([input]) => input);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls.every((c) => c.limit <= 1_000)).toBe(true);
    const afters = calls.map((c) => c.afterPosition);
    expect([...afters].sort((a, b) => a - b)).toEqual(afters);
    expect(new Set(afters).size).toBe(afters.length);
    expect(seen.filter((q) => /\boffset\b/i.test(q))).toEqual([]);
  });

  it('S27 AS-74: a slow client holds the stream back, and a client that leaves stops the reading and is counted', async () => {
    t.config.sitemapPageCapacity = 5_000;
    const s = await synced();
    // 20 locales per story: the page is hundreds of megabytes, far more than the sockets can take in
    await bulk(s, 5_000, 20);
    const spy = jest.spyOn(SequelizeSitemapReader.prototype, 'readBatch');
    const abortedBefore =
      MetricsRegistry.value('story_sitemap_aborted_total') ?? 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          {
            host: '127.0.0.1',
            port: port(),
            path: '/api/sitemaps/stories-0.xml',
          },
          (res) => {
            let read = 0;
            res.on('readable', () => undefined); // paused-mode reading: data moves only when asked for
            const reader = setInterval(() => {
              const chunk = res.read(1024) as Buffer | null;
              if (chunk) read += chunk.length;
            }, 25);
            setTimeout(() => {
              clearInterval(reader);
              try {
                expect(read).toBeGreaterThan(0);
                // 600 ms of a client that reads 1 KB at a time: the store was asked for the first batch only (or the next)
                expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
                req.destroy();
                resolve();
              } catch (error) {
                reject(error);
              }
            }, 600);
          },
        );
        req.on('error', () => undefined);
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const afterLeaving = spy.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(spy.mock.calls.length).toBe(afterLeaving);
      expect(afterLeaving).toBeLessThanOrEqual(2);
      expect(
        MetricsRegistry.value('story_sitemap_aborted_total') ?? 0,
      ).toBeGreaterThan(abortedBefore);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('S27 AS-75: a store failure on the second batch ends the connection abnormally, never with a closing tag', async () => {
    t.config.sitemapPageCapacity = 5_000;
    const s = await synced();
    await bulk(s, 2_500);
    const original = SequelizeSitemapReader.prototype.readBatch;
    let calls = 0;
    jest
      .spyOn(SequelizeSitemapReader.prototype, 'readBatch')
      .mockImplementation(async function (this: SequelizeSitemapReader, input) {
        calls++;
        if (calls === 2) throw new Error('connection to db-host-3 lost');
        return original.call(this, input);
      });
    const outcome = await new Promise<{
      complete: boolean;
      body: string;
      error: boolean;
    }>((resolve) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: port(),
          path: '/api/sitemaps/stories-0.xml',
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('error', () =>
            resolve({ complete: res.complete, body, error: true }),
          );
          res.on('aborted', () =>
            resolve({ complete: false, body, error: true }),
          );
          res.on('close', () =>
            resolve({ complete: res.complete, body, error: false }),
          );
        },
      );
      req.on('error', () => undefined);
    });
    expect(outcome.complete).toBe(false);
    expect(outcome.body).not.toContain('</urlset>');
    expect(outcome.body).not.toContain('db-host-3');
  });

  it('S27 AS-75: a store failure before the first batch is a 503 problem with Retry-After and a generic detail', async () => {
    const s = await synced();
    await t.published(s);
    jest
      .spyOn(SequelizeSitemapReader.prototype, 'readBatch')
      .mockRejectedValue(
        new Error(
          'password authentication failed for user "stories" at db-host-3',
        ),
      );
    const res = await page(0).expect(503);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.text).not.toMatch(/password|db-host-3|stories"/);
  });
});
