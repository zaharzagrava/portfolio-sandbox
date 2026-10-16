import {
  previewTokenSchema,
  publicStorySchema,
} from '@marketplace-sandbox/contracts';
import {
  createStoryApp,
  expectContract,
  type StoryTestApp,
} from './testing/story-client';

/**
 * One end-to-end walk through the story lifecycle (draft → publish → read → republish → preview). It replaces the
 * former service-level spec; the per-scenario depth lives in the story-*.e2e-spec.ts files.
 */
describe('Brand stories: lifecycle walk-through', () => {
  let t: StoryTestApp;
  beforeAll(async () => {
    t = await createStoryApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const read = (shopSlug: string, slug: string, locale = 'en') =>
    t.http().get(`/api/stories/${shopSlug}/${slug}/${locale}`);

  it('S27 AS-05 AS-06: a draft is sanitised at write time and invisible until published', async () => {
    const s = await t.seller();
    await t.syncShop(s);
    const story = await t.createStory(s, 'inside-iphone-18');
    const saved = await t
      .saveDraft(s, story.id, 'en', {
        title: 'Inside',
        blocks: [
          {
            type: 'richText',
            html: '<p>Titanium. <script>alert(1)</script><a href="javascript:x()">x</a><a href="https://apple.com" onclick="steal()">site</a></p>',
          },
        ],
      })
      .expect(200);
    const html = JSON.stringify(saved.body);
    expect(html).not.toMatch(/<script/);
    expect(html).not.toMatch(/javascript:/);
    expect(html).not.toMatch(/onclick/);
    expect(html).toContain('Titanium');
    await read(s.shopSlug, story.slug).expect(404);
  });

  it('S27 AS-20 AS-25: publishing makes version 1 public with the edge cache contract', async () => {
    const s = await t.seller();
    await t.syncShop(s);
    const story = await t.published(s, { slug: 'inside-iphone-18' });
    const res = await read(s.shopSlug, story.slug).expect(200);
    const body = expectContract(publicStorySchema, res.body);
    expect(body.id).toBe(story.id);
    expect(body.version).toBe(1);
    expect(body.preview).toBe(false);
    expect(body.shopId).toBe(s.shopId);
    expect(res.headers['cache-control']).toBe(
      'public, s-maxage=300, stale-while-revalidate=86400',
    );
    expect(res.headers['cache-tag']).toBe(`story:${story.id},shop:${s.shopId}`);
    expect(res.headers.etag).toBe(`"${story.id}-v1-en"`);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('S27 AS-21 AS-23: a republish serves version 2 and a stale expectedVersion is refused', async () => {
    const s = await t.seller();
    await t.syncShop(s);
    const story = await t.published(s);
    await t.saveDraft(s, story.id, 'en', { title: 'Second' }, 1).expect(200);
    await t.publish(s, story.id, { expectedVersion: 0 }).expect(409);
    await t.publish(s, story.id, { expectedVersion: 1 }).expect(200);
    const res = await read(s.shopSlug, story.slug).expect(200);
    expect(res.body.version).toBe(2);
    expect(res.body.title).toBe('Second');
    expect(res.headers.etag).toBe(`"${story.id}-v2-en"`);
    const stale = await read(s.shopSlug, story.slug)
      .set('If-None-Match', `"${story.id}-v1-en"`)
      .expect(200);
    expect(stale.body.version).toBe(2);
    await read(s.shopSlug, story.slug)
      .set('If-None-Match', `"${story.id}-v2-en"`)
      .expect(304);
  });

  it('S27 AS-27: a locale without a translation falls back to the default locale', async () => {
    const s = await t.seller();
    await t.syncShop(s);
    const story = await t.published(s, { locales: ['en', 'fr'] });
    const fr = await read(s.shopSlug, story.slug, 'fr').expect(200);
    expect(fr.body.locale).toBe('fr');
    const de = await read(s.shopSlug, story.slug, 'de').expect(200);
    expect(de.body.locale).toBe('en');
    const en = await read(s.shopSlug, story.slug, 'en').expect(200);
    expect(de.body.canonical).toBe(en.body.canonical);
    expect(de.body.alternates).toEqual(fr.body.alternates);
    await read(s.shopSlug, 'no-such-story').expect(404);
  });

  it('S27 AS-60 AS-61: a preview token shows the unpublished draft, uncacheable', async () => {
    const s = await t.seller();
    await t.syncShop(s);
    const story = await t.createStory(s);
    await t.saveDraft(s, story.id, 'en', { title: 'Draft only' }).expect(200);
    const minted = await t
      .post(s, `/api/shops/${s.shopId}/stories/${story.id}/preview-token`, {
        locale: 'en',
      })
      .expect(200);
    const { token } = expectContract(previewTokenSchema, minted.body);
    const res = await t
      .http()
      .get('/api/stories/preview')
      .set('X-Preview-Token', token)
      .expect(200);
    expect(res.body.title).toBe('Draft only');
    expect(res.body.preview).toBe(true);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    await read(s.shopSlug, story.slug).expect(404);
  });
});
