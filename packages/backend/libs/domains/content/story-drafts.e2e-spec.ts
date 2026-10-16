import {
  pageSchema,
  storyAdminSchema,
  storyDraftSchema,
  storyListItemSchema,
} from '@marketplace-sandbox/contracts';
import { STORY_DEFAULTS } from './domain/limits';
import {
  createStoryApp,
  expectContract,
  type Seller,
  type StoryTestApp,
} from './testing/story-client';

describe('Brand stories: create stories and write drafts (validation, sanitisation, concurrency)', () => {
  let t: StoryTestApp;
  beforeAll(async () => {
    t = await createStoryApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const path = (s: Seller, rest = '') =>
    `/api/shops/${s.shopId}/stories${rest}`;
  const storyCount = async (shopId: string) =>
    Number(
      (
        await t.rows<{ n: string }>(
          `SELECT count(*) AS n FROM "Story" WHERE "shopId" = :shopId`,
          { shopId },
        )
      )[0].n,
    );
  const draftRow = async (storyId: string, locale: string) =>
    (
      await t.rows<{ title: string; revision: number; blocks: unknown[] }>(
        `SELECT "title", "revision", "blocks" FROM "StoryDraft" WHERE "storyId" = :storyId AND "locale" = :locale`,
        { storyId, locale },
      )
    )[0];

  // ------------------------------------------------------------------------------------------------ AS-01

  it('S27 AS-01: creating a story answers 201 with the draft story, one row, one history row and no event', async () => {
    const s = await t.seller();
    const res = await t
      .post(s, path(s), { slug: 'inside-iphone-18', defaultLocale: 'uk' })
      .expect(201);
    const story = expectContract(storyAdminSchema, res.body);
    expect(story).toMatchObject({
      shopId: s.shopId,
      slug: 'inside-iphone-18',
      defaultLocale: 'uk',
      status: 'DRAFT',
      publishedVersion: null,
      scheduledAt: null,
      scheduleFailure: null,
    });
    expect(story.drafts).toBeUndefined();
    expect(await storyCount(s.shopId)).toBe(1);
    const history = await t.rows<{
      action: string;
      from: string | null;
      to: string;
      actor: string;
    }>(
      `SELECT "action", "from", "to", "actor" FROM "StoryTransition" WHERE "storyId" = :id`,
      { id: story.id },
    );
    expect(history).toEqual([
      { action: 'create', from: null, to: 'DRAFT', actor: s.id },
    ]);
    expect(await t.outbox(story.id)).toHaveLength(0);
  });

  it('S27 AS-01: an omitted default locale is stored as en', async () => {
    const s = await t.seller();
    const res = await t.post(s, path(s), { slug: 'plain' }).expect(201);
    expect(res.body.defaultLocale).toBe('en');
  });

  // ------------------------------------------------------------------------------------------------ AS-02

  it.each([
    ['uppercase slug', { slug: 'Inside' }, 'slug'],
    ['one-character slug', { slug: 'a' }, 'slug'],
    ['82-character slug', { slug: 'a'.repeat(82) }, 'slug'],
    ['slug with a leading dash', { slug: '-abc' }, 'slug'],
    ['slug with an underscore', { slug: 'a_b' }, 'slug'],
    ['slug with a slash', { slug: 'a/b' }, 'slug'],
    ['slug with a space', { slug: 'a b' }, 'slug'],
    [
      'default locale EN_us',
      { slug: 'abc', defaultLocale: 'EN_us' },
      'defaultLocale',
    ],
    [
      'default locale english',
      { slug: 'abc', defaultLocale: 'english' },
      'defaultLocale',
    ],
    ['unknown property', { slug: 'abc', status: 'PUBLISHED' }, 'status'],
    ['no body', undefined, 'body'],
  ])(
    'S27 AS-02: %s answers 400 validation_failed naming the field and creates nothing',
    async (_name, body, field) => {
      const s = await t.seller();
      const res = await t
        .post(s, path(s), body as object | undefined)
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(
        (res.body.errors as { field: string }[]).map((e) => e.field),
      ).toContain(field);
      expect(await storyCount(s.shopId)).toBe(0);
    },
  );

  // ------------------------------------------------------------------------------------------------ AS-03

  it('S27 AS-03: a duplicate slug is 409 slug_taken in the same shop and fine in another', async () => {
    const s = await t.seller();
    const other = await t.seller();
    await t.post(s, path(s), { slug: 'inside-iphone-18' }).expect(201);
    const dup = await t
      .post(s, path(s), { slug: 'inside-iphone-18' })
      .expect(409);
    expect(dup.body.code).toBe('slug_taken');
    expect(await storyCount(s.shopId)).toBe(1);
    await t.post(other, path(other), { slug: 'inside-iphone-18' }).expect(201);
  });

  it('S27 AS-03: 10 identical creates at once give one 201 and nine 409, twenty times over', async () => {
    for (let round = 0; round < 20; round++) {
      // a shop of its own per round: the 121st write of a minute is refused (AS-94)
      const s = await t.seller();
      const slug = `race-${round}`;
      const results = await Promise.all(
        Array.from({ length: 10 }, () => t.post(s, path(s), { slug })),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const losers = results.filter((r) => r.status === 409);
      expect(losers).toHaveLength(9);
      for (const loser of losers) expect(loser.body.code).toBe('slug_taken');
      expect(await storyCount(s.shopId)).toBe(1);
    }
  });

  it('S27 AS-03: no route changes a slug', async () => {
    const s = await t.seller();
    const story = await t.createStory(s, 'permanent');
    const put = await t.put(s, path(s, `/${story.id}`), { slug: 'other' });
    const patch = await t
      .http()
      .patch(path(s, `/${story.id}`))
      .set(s.auth)
      .send({ slug: 'x' });
    // there is no such route: the platform answers not found / method not allowed, never a success
    for (const res of [put, patch]) expect([404, 405]).toContain(res.status);
    const [row] = await t.rows<{ slug: string }>(
      `SELECT "slug" FROM "Story" WHERE "id" = :id`,
      { id: story.id },
    );
    expect(row.slug).toBe('permanent');
  });

  // ------------------------------------------------------------------------------------------------ AS-04

  it('S27 AS-04: a shop at its story limit gets 422 story_limit_reached, archived stories counting', async () => {
    // the services hold this very object, so the limit can be lowered for one test
    t.config.maxStoriesPerShop = 3;
    const limited = t;
    try {
      const s = await limited.seller();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await limited.createStory(s)).id);
      const res = await limited
        .post(s, `/api/shops/${s.shopId}/stories`, { slug: 'one-more' })
        .expect(422);
      expect(res.body.code).toBe('story_limit_reached');
      expect(res.body.limit).toBe(3);
      const other = await limited.seller();
      await limited.createStory(other);
      expect(
        Number(
          (
            await limited.rows<{ n: string }>(
              `SELECT count(*) AS n FROM "Story" WHERE "shopId" = :shopId`,
              { shopId: s.shopId },
            )
          )[0].n,
        ),
      ).toBe(3);
      // archived stories count
      await limited.saveDraft(s, ids[0], 'en').expect(200);
      await limited.publish(s, ids[0], { expectedVersion: 0 }).expect(200);
      await limited
        .post(s, `/api/shops/${s.shopId}/stories/${ids[0]}/archive`)
        .expect(200);
      await limited
        .post(s, `/api/shops/${s.shopId}/stories`, { slug: 'still-no' })
        .expect(422);
    } finally {
      t.config.maxStoriesPerShop = STORY_DEFAULTS.maxStoriesPerShop;
    }
  });

  // ------------------------------------------------------------------------------------------------ AS-05

  it('S27 AS-05: a draft is saved at revision 1, updated to 2, and read back with the story state', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    const first = await t
      .saveDraft(
        s,
        story.id,
        'en',
        { title: 'One', seo: { description: 'd' } },
        0,
      )
      .expect(200);
    expect(expectContract(storyDraftSchema, first.body)).toMatchObject({
      locale: 'en',
      revision: 1,
      title: 'One',
      seo: { description: 'd' },
    });
    const second = await t
      .saveDraft(s, story.id, 'en', { title: 'Two' }, 1)
      .expect(200);
    expect(second.body.revision).toBe(2);
    await t.saveDraft(s, story.id, 'uk', { title: 'Два' }, 0).expect(200);
    const detail = await t.get(s, path(s, `/${story.id}`)).expect(200);
    const parsed = expectContract(storyAdminSchema, detail.body);
    expect(parsed).toMatchObject({
      status: 'DRAFT',
      publishedVersion: null,
      scheduledAt: null,
      scheduleFailure: null,
    });
    expect(parsed.drafts?.map((d) => [d.locale, d.revision, d.title])).toEqual([
      ['en', 2, 'Two'],
      ['uk', 1, 'Два'],
    ]);
  });

  // ------------------------------------------------------------------------------------------------ AS-06, AS-07

  it('S27 AS-06: hostile rich text is sanitised on save and the stored result is stable', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    const html =
      '<p>Titanium. <script>alert(1)</script><a href="javascript:x()">x</a><a href="https://apple.com" onclick="steal()">site</a></p>';
    const res = await t
      .saveDraft(s, story.id, 'en', { blocks: [{ type: 'richText', html }] }, 0)
      .expect(200);
    const saved = (res.body.blocks[0] as { html: string }).html;
    expect(saved).toContain(
      '<a href="https://apple.com" rel="noopener">site</a>',
    );
    expect(saved).not.toMatch(/script|javascript:|onclick/);
    const again = await t
      .saveDraft(
        s,
        story.id,
        'en',
        { blocks: [{ type: 'richText', html: saved }] },
        1,
      )
      .expect(200);
    expect((again.body.blocks[0] as { html: string }).html).toBe(saved);
    expect((await draftRow(story.id, 'en')).blocks).toEqual([
      { type: 'richText', html: saved },
    ]);
  });

  it('S27 AS-07: plain-text fields come back byte for byte, as JSON with nosniff', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    const title = '<img src=x onerror=alert(1)>';
    const quote = '"><b>';
    await t
      .saveDraft(
        s,
        story.id,
        'en',
        { title, blocks: [{ type: 'quote', text: quote }] },
        0,
      )
      .expect(200);
    const detail = await t.get(s, path(s, `/${story.id}`)).expect(200);
    expect(detail.headers['content-type']).toMatch(/^application\/json/);
    expect(detail.headers['x-content-type-options']).toBe('nosniff');
    expect(detail.body.drafts[0].title).toBe(title);
    expect(detail.body.drafts[0].blocks[0].text).toBe(quote);
    expect(detail.text).toContain(JSON.stringify(title).slice(1, -1));
  });

  // ------------------------------------------------------------------------------------------------ AS-08

  describe('S27 AS-08: drafts that are refused leave the stored draft at its revision', () => {
    let s: Seller;
    let storyId: string;
    beforeAll(async () => {
      s = await t.seller();
      storyId = (await t.createStory(s)).id;
      for (let revision = 0; revision < 3; revision++)
        await t
          .saveDraft(s, storyId, 'en', { title: `v${revision}` }, revision)
          .expect(200);
    });

    const save = (body: object) =>
      t.put(s, path(s, `/${storyId}/drafts/en`), body);
    const okBody = (extra: object = {}) => ({
      title: 't',
      blocks: [],
      expectedRevision: 3,
      ...extra,
    });
    const image = {
      type: 'image',
      url: 'https://cdn.example.com/a.png',
      alt: 'a',
      width: 1,
      height: 1,
    };

    afterEach(async () => {
      const row = await draftRow(storyId, 'en');
      expect(row.revision).toBe(3);
      expect(row.title).toBe('v2');
    });

    it.each([
      ['an unknown block type', [{ type: 'carousel' }]],
      ['heading level 4', [{ type: 'heading', level: 4, text: 'x' }]],
      [
        'a rich text over 20,000 characters',
        [{ type: 'richText', html: 'x'.repeat(20_001) }],
      ],
      [
        'an image over http',
        [{ ...image, url: 'http://cdn.example.com/a.png' }],
      ],
      [
        'an image without alt',
        [{ type: 'image', url: image.url, width: 1, height: 1 }],
      ],
      ['an alt over 300 characters', [{ ...image, alt: 'a'.repeat(301) }]],
      ['a width of 0', [{ ...image, width: 0 }]],
      ['a negative height', [{ ...image, height: -5 }]],
      ['a product that is not a uuid', [{ type: 'product', productId: '123' }]],
      [
        'a quote over 500 characters',
        [{ type: 'quote', text: 'q'.repeat(501) }],
      ],
      [
        'a video on a look-alike host',
        [{ type: 'video', url: 'https://www.youtube.com.evil.example/x' }],
      ],
      [
        'a video with user info',
        [{ type: 'video', url: 'https://www.youtube.com@evil.example/x' }],
      ],
      [
        'a video with credentials',
        [{ type: 'video', url: 'https://u:p@www.youtube.com/x' }],
      ],
      [
        'a video on another port',
        [{ type: 'video', url: 'https://www.youtube.com:8443/x' }],
      ],
      [
        'an unlisted stream path',
        [
          {
            type: 'video',
            url: 'https://stream.marketplace.dev/u/abc/master.m3u8',
          },
        ],
      ],
      [
        'more than 200 blocks',
        Array.from({ length: 201 }, () => ({
          type: 'heading',
          level: 2,
          text: 'x',
        })),
      ],
    ])(
      'refuses %s with 422 invalid_blocks and no value echoed',
      async (_name, blocks) => {
        const res = await save(okBody({ blocks })).expect(422);
        expect(res.body.code).toBe('invalid_blocks');
        expect(res.body.issues.length).toBeLessThanOrEqual(10);
        expect(res.body.issues.length).toBeGreaterThan(0);
        for (const issue of res.body.issues) {
          expect(typeof issue.path).toBe('string');
          expect(typeof issue.code).toBe('string');
        }
        expect(res.text).not.toContain('evil.example');
      },
    );

    it('refuses a seo image that is not https with 422 invalid_blocks', async () => {
      const res = await save(
        okBody({ seo: { ogImage: 'http://a.example/i.png' } }),
      ).expect(422);
      expect(res.body.code).toBe('invalid_blocks');
    });

    it.each([
      ['an empty title', ''],
      ['a title over 200 characters', 'x'.repeat(201)],
    ])('refuses %s with 422 invalid_title', async (_name, title) => {
      const res = await save(okBody({ title })).expect(422);
      expect(res.body.code).toBe('invalid_title');
    });

    it('refuses a draft over 256 KiB with 422 payload_too_large', async () => {
      const blocks = Array.from({ length: 14 }, () => ({
        type: 'richText',
        html: `<p>${'x'.repeat(19_990)}</p>`,
      }));
      const res = await save(okBody({ blocks })).expect(422);
      expect(res.body.code).toBe('payload_too_large');
    });

    it('refuses a request body over 1 MiB with 413', async () => {
      await save(okBody({ title: 'x'.repeat(1_100_000) })).expect(413);
    });

    it.each([
      ['blocks that are not an array', okBody({ blocks: 'x' })],
      ['a missing expectedRevision', { title: 't', blocks: [] }],
      ['an unknown property', okBody({ extra: true })],
      ['a negative expectedRevision', okBody({ expectedRevision: -1 })],
    ])('refuses %s with 400 validation_failed', async (_name, body) => {
      const res = await save(body).expect(400);
      expect(res.body.code).toBe('validation_failed');
    });
  });

  // ------------------------------------------------------------------------------------------------ AS-09

  it('S27 AS-09: two editors saving the same revision give one 200 and one 409 naming the current revision', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    await t.saveDraft(s, story.id, 'en', { title: 'base' }, 0).expect(200);
    const [a, b] = await Promise.all([
      t.saveDraft(s, story.id, 'en', { title: 'A' }, 1),
      t.saveDraft(s, story.id, 'en', { title: 'B' }, 1),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 200 ? a : b;
    expect(loser.body.code).toBe('revision_conflict');
    expect(loser.body.currentRevision).toBe(2);
    expect((await draftRow(story.id, 'en')).title).toBe(winner.body.title);
  });

  it('S27 AS-09: twenty saves of one revision at once give one winner and nineteen conflicts', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    await t.saveDraft(s, story.id, 'en', { title: 'base' }, 0).expect(200);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        t.saveDraft(s, story.id, 'en', { title: `w${i}` }, 1),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect((await draftRow(story.id, 'en')).revision).toBe(2);
  });

  it('S27 AS-09: a stale revision, a new locale with revision 1 and an existing locale with 0 are conflicts', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    await t.saveDraft(s, story.id, 'en', {}, 0).expect(200);
    await t.saveDraft(s, story.id, 'en', {}, 1).expect(200);
    const stale = await t.saveDraft(s, story.id, 'en', {}, 1).expect(409);
    expect(stale.body).toMatchObject({
      code: 'revision_conflict',
      currentRevision: 2,
    });
    const fresh = await t.saveDraft(s, story.id, 'uk', {}, 1).expect(409);
    expect(fresh.body).toMatchObject({
      code: 'revision_conflict',
      currentRevision: 0,
    });
    const existing = await t.saveDraft(s, story.id, 'en', {}, 0).expect(409);
    expect(existing.body).toMatchObject({
      code: 'revision_conflict',
      currentRevision: 2,
    });
  });

  // ------------------------------------------------------------------------------------------------ AS-10

  it('S27 AS-10: a 21st locale is 422 locale_limit_reached, malformed locales are 400, existing locales still save', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    const locales = Array.from(
      { length: 20 },
      (_, i) => `a${String.fromCharCode(97 + i)}`,
    );
    for (const locale of locales)
      await t.saveDraft(s, story.id, locale, {}, 0).expect(200);
    const over = await t.saveDraft(s, story.id, 'zz', {}, 0).expect(422);
    expect(over.body).toMatchObject({
      code: 'locale_limit_reached',
      limit: 20,
    });
    expect(await draftRow(story.id, 'zz')).toBeUndefined();
    await t.saveDraft(s, story.id, 'aa', {}, 1).expect(200);
    for (const bad of ['EN_us', 'e', 'english', 'en-us'])
      expect(
        (await t.saveDraft(s, story.id, bad, {}, 0).expect(400)).body.code,
      ).toBe('validation_failed');
  });

  it('S27 AS-10: twenty concurrent new locales on a full story cannot exceed the limit', async () => {
    t.config.maxLocales = 3;
    const limited = t;
    try {
      const s = await limited.seller();
      const story = await limited.createStory(s);
      const results = await Promise.all(
        ['aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah'].map((l) =>
          limited.saveDraft(s, story.id, l, {}, 0),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
      expect(results.filter((r) => r.status === 422)).toHaveLength(5);
    } finally {
      t.config.maxLocales = STORY_DEFAULTS.maxLocales;
    }
  });

  // ------------------------------------------------------------------------------------------------ AS-11

  it('S27 AS-11: a non-default draft is deleted with its revision, the default one never', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    await t.saveDraft(s, story.id, 'en', {}, 0).expect(200);
    await t.saveDraft(s, story.id, 'en', {}, 1).expect(200);
    for (let revision = 0; revision < 4; revision++)
      await t.saveDraft(s, story.id, 'uk', {}, revision).expect(200);
    const url = (locale: string, revision: number) =>
      path(s, `/${story.id}/drafts/${locale}?expectedRevision=${revision}`);
    const wrong = await t.del(s, url('uk', 3)).expect(409);
    expect(wrong.body).toMatchObject({
      code: 'revision_conflict',
      currentRevision: 4,
    });
    expect((await t.del(s, url('fr', 1)).expect(404)).body.code).toBe(
      'draft_not_found',
    );
    const protectedLocale = await t.del(s, url('en', 2)).expect(409);
    expect(protectedLocale.body.code).toBe('default_locale_required');
    expect(await draftRow(story.id, 'en')).toBeDefined();
    await t.del(s, url('uk', 4)).expect(204);
    expect(await draftRow(story.id, 'uk')).toBeUndefined();
  });

  // ------------------------------------------------------------------------------------------------ AS-12

  it('S27 AS-12: the list pages newest first without gaps or repeats, filters by status and never shows another shop', async () => {
    const s = await t.seller();
    const other = await t.seller();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      await t.advance(1_000);
      ids.push(
        i === 1 || i === 4
          ? (await t.published(s)).id
          : (await t.createStory(s)).id,
      );
    }
    await t.createStory(other);
    await t.createStory(other);
    const viewer = await t.member(s.shopId, 'VIEWER');
    for (const reader of [s, viewer]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      const sizes: number[] = [];
      do {
        const query: string = `limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await t.get(reader, path(s, `?${query}`)).expect(200);
        const page = expectContract(pageSchema(storyListItemSchema), res.body);
        sizes.push(page.items.length);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(sizes).toEqual([3, 3, 1]);
      expect(seen).toEqual([...ids].reverse());
    }
    const published = await t.get(s, path(s, '?status=PUBLISHED')).expect(200);
    expect(published.body.items.map((i: { id: string }) => i.id)).toEqual([
      ids[4],
      ids[1],
    ]);
    expect(published.body.nextCursor).toBeNull();
    for (const bad of [
      'limit=0',
      'limit=101',
      'limit=abc',
      'cursor=!!!',
      'status=SCHEDULED',
    ]) {
      const res = await t.get(s, path(s, `?${bad}`)).expect(400);
      expect(res.body.code).toBe('validation_failed');
    }
    // a cursor of another list or with a changed value is refused
    const firstPage = await t.get(s, path(s, '?limit=3')).expect(200);
    const tampered = Buffer.from(
      Buffer.from(firstPage.body.nextCursor, 'base64url')
        .toString()
        .replace(/\d/, '9'),
    ).toString('base64url');
    await t.get(s, path(s, `?cursor=${tampered}`)).expect(400);
  });

  it('S27 AS-12: the draft detail needs products.write: a viewer is refused', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    const viewer = await t.member(s.shopId, 'VIEWER');
    const res = await t.get(viewer, path(s, `/${story.id}`)).expect(403);
    expect(res.body.code).toBe('permission_denied');
  });

  it('S27 AS-12: story ids are scoped to the shop: an id of another shop is a 404', async () => {
    const s = await t.seller();
    const other = await t.seller();
    const story = await t.createStory(other);
    const res = await t.get(s, path(s, `/${story.id}`)).expect(404);
    expect(res.body.code).toBe('story_not_found');
  });
});
