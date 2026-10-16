import {
  pageSchema,
  storyAdminSchema,
  storyVersionListItemSchema,
  storyVersionSchema,
} from '@marketplace-sandbox/contracts';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { readModelKey } from './infra/story-read-model';
import { deliver } from './testing/events';
import {
  createStoryApp,
  expectContract,
  type Seller,
  type StoryTestApp,
} from './testing/story-client';

const HOUR = 3_600_000;

describe('Brand stories: archive, version history and restore', () => {
  let t: StoryTestApp;
  beforeAll(async () => {
    t = await createStoryApp();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    t.cdn.reset();
    t.front.reset();
  });

  const base = (s: Seller, storyId: string) =>
    `/api/shops/${s.shopId}/stories/${storyId}`;
  const synced = async () => {
    const s = await t.seller();
    await t.syncShop(s);
    return s;
  };
  const storyRow = async (storyId: string) =>
    (
      await t.rows<{
        status: string;
        publishedVersion: number | null;
        scheduledAt: Date | null;
        sitemapPosition: string | null;
      }>(
        `SELECT "status", "publishedVersion", "scheduledAt", "sitemapPosition" FROM "Story" WHERE "id" = :storyId`,
        { storyId },
      )
    )[0];
  const history = async (storyId: string) =>
    (
      await t.rows<{ action: string }>(
        `SELECT "action" FROM "StoryTransition" WHERE "storyId" = :storyId ORDER BY "occurredAt", "id"`,
        { storyId },
      )
    ).map((r) => r.action);
  const eventTypes = async (storyId: string) =>
    (await t.outbox(storyId)).map((e) => e.type);
  const archive = (s: Seller, storyId: string) =>
    t.post(s, `${base(s, storyId)}/archive`);

  // ------------------------------------------------------------------------------------------------ AS-80

  it('S27 AS-80: archiving takes the story down, clears its schedule and records the event and the history in one transaction', async () => {
    const s = await synced();
    const story = await t.published(s);
    await t.saveDraft(s, story.id, 'en', { title: 'Two' }, 1).expect(200);
    await t.publish(s, story.id, { expectedVersion: 1 }).expect(200);
    await t.saveDraft(s, story.id, 'en', { title: 'Three' }, 2).expect(200);
    await t
      .publish(s, story.id, {
        expectedVersion: 2,
        at: new Date(t.clock.now().getTime() + HOUR).toISOString(),
      })
      .expect(200);
    const url = `/api/stories/${s.shopSlug}/${story.slug}/en`;
    await t.http().get(url).expect(200);
    const redis = t.app.get(RedisService);
    const key = readModelKey(s.shopSlug, story.slug);
    expect(await redis.client.exists(key)).toBe(1);

    const res = await archive(s, story.id).expect(200);
    expect(res.body).toEqual({ status: 'ARCHIVED' });
    expect(await storyRow(story.id)).toMatchObject({
      status: 'ARCHIVED',
      publishedVersion: 2,
      scheduledAt: null,
    });
    expect((await history(story.id)).slice(-1)).toEqual(['archive']);
    const events = await t.outbox(story.id);
    expect(events.at(-1)?.type).toBe('story.archived');
    expect((events.at(-1)?.payload as { payload: unknown }).payload).toEqual({
      storyId: story.id,
      shopId: s.shopId,
      shopSlug: s.shopSlug,
      slug: story.slug,
      version: 2,
    });
    expect(await redis.client.exists(key)).toBe(0);
    await t.http().get(url).expect(404);
    // versions and drafts remain
    const detail = await t.get(s, base(s, story.id)).expect(200);
    expect(detail.body.drafts).toHaveLength(1);
    expect(
      (await t.get(s, `${base(s, story.id)}/versions`).expect(200)).body.items,
    ).toHaveLength(2);

    await deliver(t.invalidation, events.at(-1)!.payload as never);
    expect(t.cdn.bodies<{ tags: string[] }>()[0].tags).toEqual([
      `story:${story.id}`,
      `shop:${s.shopId}`,
    ]);
  });

  // ------------------------------------------------------------------------------------------------ AS-81

  it('S27 AS-81: publishing an archived story brings it back as the next version at its old sitemap position', async () => {
    const s = await synced();
    const story = await t.published(s);
    await t.saveDraft(s, story.id, 'en', { title: 'Two' }, 1).expect(200);
    await t.publish(s, story.id, { expectedVersion: 1 }).expect(200);
    const before = (await storyRow(story.id)).sitemapPosition;
    await archive(s, story.id).expect(200);
    await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(404);
    const res = await t
      .publish(s, story.id, { expectedVersion: 2 })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'PUBLISHED', version: 3 });
    const row = await storyRow(story.id);
    expect(row).toMatchObject({ status: 'PUBLISHED', publishedVersion: 3 });
    expect(row.sitemapPosition).toBe(before);
    expect(
      (
        await t
          .http()
          .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
          .expect(200)
      ).body.version,
    ).toBe(3);
  });

  // ------------------------------------------------------------------------------------------------ AS-82

  it('S27 AS-82: archiving a draft or an archived story, and cancelling a schedule that is not there, are refused and change nothing', async () => {
    const s = await synced();
    const draft = await t.createStory(s);
    await t.saveDraft(s, draft.id, 'en').expect(200);
    const refused = await archive(s, draft.id).expect(409);
    expect(refused.body).toMatchObject({
      code: 'invalid_transition',
      currentStatus: 'DRAFT',
    });
    expect(await storyRow(draft.id)).toMatchObject({ status: 'DRAFT' });
    expect(await history(draft.id)).toEqual(['create']);
    expect(await eventTypes(draft.id)).toEqual([]);

    const story = await t.published(s);
    await archive(s, story.id).expect(200);
    const again = await archive(s, story.id).expect(409);
    expect(again.body).toMatchObject({
      code: 'invalid_transition',
      currentStatus: 'ARCHIVED',
    });
    expect(await history(story.id)).toEqual(['create', 'publish', 'archive']);
    expect(await eventTypes(story.id)).toEqual([
      'story.published',
      'story.archived',
    ]);

    const none = await t.del(s, `${base(s, story.id)}/schedule`).expect(409);
    expect(none.body.code).toBe('not_scheduled');
    expect(await history(story.id)).toEqual(['create', 'publish', 'archive']);
  });

  it('S27 AS-82: the allowed moves succeed: draft→published, published→published, published→archived, archived→published', async () => {
    const s = await synced();
    const story = await t.createStory(s);
    await t.saveDraft(s, story.id, 'en').expect(200);
    await t.publish(s, story.id, { expectedVersion: 0 }).expect(200);
    await t.saveDraft(s, story.id, 'en', { title: 'x' }, 1).expect(200);
    await t.publish(s, story.id, { expectedVersion: 1 }).expect(200);
    await archive(s, story.id).expect(200);
    await t.publish(s, story.id, { expectedVersion: 2 }).expect(200);
    expect(await history(story.id)).toEqual([
      'create',
      'publish',
      'publish',
      'archive',
      'publish',
    ]);
  });

  // ------------------------------------------------------------------------------------------------ AS-83

  it('S27 AS-83: a publish and an archive at once leave a status that matches the last event, with gapless versions, twenty times', async () => {
    for (let round = 0; round < 20; round++) {
      const s = await synced();
      const story = await t.published(s);
      await t
        .saveDraft(s, story.id, 'en', { title: `round ${round}` }, 1)
        .expect(200);
      const [a, b] = await Promise.all([
        t.publish(s, story.id, { expectedVersion: 1 }),
        archive(s, story.id),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const types = await eventTypes(story.id);
      const last = types.at(-1);
      const row = await storyRow(story.id);
      expect(row.status).toBe(
        last === 'story.archived' ? 'ARCHIVED' : 'PUBLISHED',
      );
      expect(types.filter((x) => x === 'story.published')).toHaveLength(2);
      expect(types.filter((x) => x === 'story.archived')).toHaveLength(1);
      const versions = await t.rows<{ version: number }>(
        `SELECT DISTINCT "version" FROM "StoryVersion" WHERE "storyId" = :id ORDER BY "version"`,
        { id: story.id },
      );
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      expect(row.publishedVersion).toBe(2);
    }
  });

  // ------------------------------------------------------------------------------------------------ AS-84

  describe('S27 AS-84 / AS-85: versions and restore', () => {
    const history3 = async () => {
      const s = await synced();
      const story = await t.createStory(s);
      await t
        .saveDraft(s, story.id, 'en', {
          title: 'One',
          seo: { description: 'first' },
        })
        .expect(200);
      await t.saveDraft(s, story.id, 'uk', { title: 'Один' }).expect(200);
      await t.publish(s, story.id, { expectedVersion: 0 }).expect(200);
      await t
        .del(s, `${base(s, story.id)}/drafts/uk?expectedRevision=1`)
        .expect(204);
      await t.saveDraft(s, story.id, 'en', { title: 'Two' }, 1).expect(200);
      await t.publish(s, story.id, { expectedVersion: 1 }).expect(200);
      await t.saveDraft(s, story.id, 'en', { title: 'Three' }, 2).expect(200);
      await t.saveDraft(s, story.id, 'fr', { title: 'Trois' }).expect(200);
      await t.publish(s, story.id, { expectedVersion: 2 }).expect(200);
      return { s, story };
    };

    it('S27 AS-84: the list is newest first with a cursor, the detail is the frozen content, an unknown version is 404', async () => {
      const { s, story } = await history3();
      const first = await t
        .get(s, `${base(s, story.id)}/versions?limit=2`)
        .expect(200);
      const page1 = expectContract(
        pageSchema(storyVersionListItemSchema),
        first.body,
      );
      expect(page1.items.map((v) => [v.version, v.locales])).toEqual([
        [3, ['en', 'fr']],
        [2, ['en']],
      ]);
      expect(page1.items[0]).toMatchObject({
        publishedBy: s.id,
        publishedAt: t.clock.now().toISOString(),
      });
      const second = await t
        .get(
          s,
          `${base(s, story.id)}/versions?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        )
        .expect(200);
      expect(
        second.body.items.map((v: { version: number }) => v.version),
      ).toEqual([1]);
      expect(second.body.nextCursor).toBeNull();
      await t
        .get(s, `${base(s, story.id)}/versions?cursor=garbage`)
        .expect(400);

      const detail = await t
        .get(s, `${base(s, story.id)}/versions/1`)
        .expect(200);
      const v1 = expectContract(storyVersionSchema, detail.body);
      expect(v1.locales.map((l) => [l.locale, l.title])).toEqual([
        ['en', 'One'],
        ['uk', 'Один'],
      ]);
      expect(v1.locales[0].seo).toEqual({ description: 'first' });
      expect(
        (await t.get(s, `${base(s, story.id)}/versions/9`).expect(404)).body
          .code,
      ).toBe('version_not_found');
      expect(
        (await t.get(s, `${base(s, story.id)}/versions/abc`).expect(404)).body
          .code,
      ).toBe('version_not_found');
    });

    it('S27 AS-84: a version never changes after later draft edits or publishes', async () => {
      const { s, story } = await history3();
      const before = (
        await t.get(s, `${base(s, story.id)}/versions/1`).expect(200)
      ).text;
      await t.saveDraft(s, story.id, 'en', { title: 'Four' }, 3).expect(200);
      await t.publish(s, story.id, { expectedVersion: 3 }).expect(200);
      expect(
        (await t.get(s, `${base(s, story.id)}/versions/1`).expect(200)).text,
      ).toBe(before);
    });

    it('S27 AS-85: restoring a version replaces the drafts, leaves what is live alone, and publishing it makes a new version', async () => {
      const { s, story } = await history3();
      const draftsBefore = (await t.get(s, base(s, story.id)).expect(200)).body
        .drafts as {
        locale: string;
        revision: number;
      }[];
      const eventsBefore = await eventTypes(story.id);
      const historyBefore = await history(story.id);
      const res = await t
        .post(s, `${base(s, story.id)}/versions/1/restore`)
        .expect(200);
      const restored = expectContract(storyAdminSchema, res.body);
      expect(restored.drafts?.map((d) => [d.locale, d.title])).toEqual([
        ['en', 'One'],
        ['uk', 'Один'],
      ]);
      const enBefore = draftsBefore.find((d) => d.locale === 'en')!;
      expect(
        restored.drafts!.find((d) => d.locale === 'en')!.revision,
      ).toBeGreaterThan(enBefore.revision);
      expect(restored).toMatchObject({
        status: 'PUBLISHED',
        publishedVersion: 3,
        scheduledAt: null,
      });
      expect(await eventTypes(story.id)).toEqual(eventsBefore);
      expect(await history(story.id)).toEqual(historyBefore);
      expect(
        (
          await t
            .http()
            .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
            .expect(200)
        ).body.title,
      ).toBe('Three');

      const published = await t
        .publish(s, story.id, { expectedVersion: 3 })
        .expect(200);
      expect(published.body.version).toBe(4);
      const v4 = (await t.get(s, `${base(s, story.id)}/versions/4`).expect(200))
        .body;
      const v1 = (await t.get(s, `${base(s, story.id)}/versions/1`).expect(200))
        .body;
      expect(v4.locales).toEqual(v1.locales);
      expect(
        (await t.get(s, `${base(s, story.id)}/versions`).expect(200)).body
          .items,
      ).toHaveLength(4);
    });

    it('S27 AS-85: restoring an unknown version is 404 and changes nothing', async () => {
      const { s, story } = await history3();
      const before = (await t.get(s, base(s, story.id)).expect(200)).text;
      expect(
        (await t.post(s, `${base(s, story.id)}/versions/9/restore`).expect(404))
          .body.code,
      ).toBe('version_not_found');
      expect((await t.get(s, base(s, story.id)).expect(200)).text).toBe(before);
    });
  });
});
