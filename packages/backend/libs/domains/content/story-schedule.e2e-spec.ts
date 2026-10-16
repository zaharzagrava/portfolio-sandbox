import {
  storyAdminSchema,
  storyPublishResultSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ProductQueryService } from '@app/domains/catalog';
import { SequelizeStoryRepository } from './infra/story.repository';
import { deliver, shopStatusEvent } from './testing/events';
import {
  createStoryApp,
  expectContract,
  type Seller,
  type StoryTestApp,
} from './testing/story-client';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('Brand stories: scheduled publish, stale jobs and the due-schedule sweep', () => {
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

  const at = (ms: number) =>
    new Date(t.clock.now().getTime() + ms).toISOString();
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
        scheduledBy: string | null;
        scheduleFailure: { at: string; code: string } | null;
        publishedAt: Date | null;
      }>(
        `SELECT "status", "publishedVersion", "scheduledAt", "scheduledBy", "scheduleFailure", "publishedAt"
           FROM "Story" WHERE "id" = :storyId`,
        { storyId },
      )
    )[0];
  const versions = async (storyId: string) =>
    (
      await t.rows<{ version: number }>(
        `SELECT DISTINCT "version" FROM "StoryVersion" WHERE "storyId" = :storyId ORDER BY "version"`,
        { storyId },
      )
    ).map((r) => r.version);
  const history = async (storyId: string) =>
    (
      await t.rows<{ action: string }>(
        `SELECT "action" FROM "StoryTransition" WHERE "storyId" = :storyId ORDER BY "occurredAt", "id"`,
        { storyId },
      )
    ).map((r) => r.action);
  const events = async (storyId: string, type: string) =>
    (await t.outbox(storyId)).filter((e) => e.type === type);
  const run = (storyId: string, scheduledAt: string, isLastAttempt = false) =>
    t.jobs.publish({ storyId, scheduledAt }, t.jobContext({ isLastAttempt }));
  const draftStory = async (s: Seller) => {
    const story = await t.createStory(s);
    await t.saveDraft(s, story.id, 'en', { title: 'Reveal' }).expect(200);
    return story;
  };
  const schedule = (
    s: Seller,
    storyId: string,
    expectedVersion: number,
    when: string,
    key?: string,
  ) => t.publish(s, storyId, { expectedVersion, at: when }, key);
  const failedCounter = () =>
    MetricsRegistry.value('story_schedule_fired_total', { result: 'failed' }) ??
    0;

  // ------------------------------------------------------------------------------------------------ AS-40

  it('S27 AS-40: scheduling keeps the status, stores the schedule, creates one keyed job and publishes nothing', async () => {
    const s = await synced();
    const story = await draftStory(s);
    const when = at(HOUR);
    const res = await schedule(s, story.id, 0, when).expect(200);
    expect(expectContract(storyPublishResultSchema, res.body)).toMatchObject({
      status: 'DRAFT',
      version: null,
      scheduledAt: when,
    });
    const row = await storyRow(story.id);
    expect(row).toMatchObject({
      status: 'DRAFT',
      publishedVersion: null,
      scheduledBy: s.id,
    });
    expect(row.scheduledAt?.toISOString()).toBe(when);
    const jobs = await t.probe.find('stories.publish', { storyId: story.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].runAt.toISOString()).toBe(when);
    expect(jobs[0].payload).toEqual({ storyId: story.id, scheduledAt: when });
    const [key] = await t.rows<{ jobId: string }>(
      `SELECT "jobId" FROM "JobKey" WHERE "idempotencyKey" = :key`,
      { key: `story-publish:${story.id}:${when}` },
    );
    expect(key.jobId).toBe(jobs[0].id);
    expect(await history(story.id)).toEqual(['create', 'schedule']);
    expect(await versions(story.id)).toEqual([]);
    expect(await events(story.id, 'story.published')).toHaveLength(0);
    await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(404);
  });

  it('S27 AS-40: a time with an offset is accepted', async () => {
    const s = await synced();
    const story = await draftStory(s);
    const when = new Date(t.clock.now().getTime() + 2 * HOUR);
    const local = `${when.toISOString().slice(0, 19)}+00:00`;
    const res = await schedule(s, story.id, 0, local).expect(200);
    expect(res.body.scheduledAt).toBe(
      when.toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    );
  });

  // ------------------------------------------------------------------------------------------------ AS-41

  it('S27 AS-41: at its time the job publishes the drafts as they are then, as the user who scheduled', async () => {
    const s = await synced();
    const story = await draftStory(s);
    const when = at(HOUR);
    await schedule(s, story.id, 0, when).expect(200);
    await t
      .saveDraft(s, story.id, 'en', { title: 'Edited after scheduling' }, 1)
      .expect(200);

    // delivered too early: nothing happens
    await run(story.id, when);
    expect(await versions(story.id)).toEqual([]);
    expect((await storyRow(story.id)).scheduledAt).not.toBeNull();

    await t.advance(HOUR);
    await run(story.id, when);
    expect(await versions(story.id)).toEqual([1]);
    const row = await storyRow(story.id);
    expect(row).toMatchObject({
      status: 'PUBLISHED',
      publishedVersion: 1,
      scheduledAt: null,
      scheduledBy: null,
    });
    expect(row.publishedAt?.toISOString()).toBe(t.clock.now().toISOString());
    const [version] = await t.rows<{ title: string; publishedBy: string }>(
      `SELECT "title", "publishedBy" FROM "StoryVersion" WHERE "storyId" = :id`,
      { id: story.id },
    );
    expect(version).toEqual({
      title: 'Edited after scheduling',
      publishedBy: s.id,
    });
    expect(await events(story.id, 'story.published')).toHaveLength(1);
    expect(await history(story.id)).toEqual(['create', 'schedule', 'fire']);
    const res = await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(200);
    expect(res.body.title).toBe('Edited after scheduling');
  });

  // ------------------------------------------------------------------------------------------------ AS-42

  it('S27 AS-42: rescheduling makes the old job stale; cancelling makes the new one a no-op', async () => {
    const s = await synced();
    const story = await draftStory(s);
    const t1 = at(HOUR);
    const t2 = at(3 * HOUR);
    await schedule(s, story.id, 0, t1, 'sched-key-0001').expect(200);
    await schedule(s, story.id, 0, t2, 'sched-key-0002').expect(200);
    expect(
      await t.probe.find('stories.publish', { storyId: story.id }),
    ).toHaveLength(2);
    expect((await storyRow(story.id)).scheduledAt?.toISOString()).toBe(t2);

    await t.advance(HOUR);
    await run(story.id, t1);
    expect(await versions(story.id)).toEqual([]);
    expect((await storyRow(story.id)).scheduledAt?.toISOString()).toBe(t2);
    expect(await events(story.id, 'story.published')).toHaveLength(0);

    await t.advance(2 * HOUR);
    await run(story.id, t2);
    expect(await versions(story.id)).toEqual([1]);
  });

  it('S27 AS-42: DELETE …/schedule clears it (204) and the job does nothing; with no schedule it is 409 not_scheduled', async () => {
    const s = await synced();
    const story = await draftStory(s);
    const when = at(HOUR);
    await schedule(s, story.id, 0, when).expect(200);
    await t.del(s, `${base(s, story.id)}/schedule`).expect(204);
    expect(await storyRow(story.id)).toMatchObject({
      scheduledAt: null,
      scheduledBy: null,
    });
    expect(await history(story.id)).toEqual([
      'create',
      'schedule',
      'cancel_schedule',
    ]);
    await t.advance(HOUR);
    await run(story.id, when);
    expect(await versions(story.id)).toEqual([]);
    const again = await t.del(s, `${base(s, story.id)}/schedule`).expect(409);
    expect(again.body.code).toBe('not_scheduled');
  });

  // ------------------------------------------------------------------------------------------------ AS-43

  it.each([
    ['in the past', () => at(-MINUTE), 422, 'schedule_in_past'],
    [
      'equal to now',
      () => t.clock.now().toISOString(),
      422,
      'schedule_in_past',
    ],
    [
      'more than 365 days ahead',
      () => at(365 * DAY + 1_000),
      422,
      'schedule_too_far',
    ],
    ['not a date', () => 'tomorrow', 400, 'validation_failed'],
    [
      'without an offset',
      () => at(HOUR).replace('Z', ''),
      400,
      'validation_failed',
    ],
  ])(
    'S27 AS-43: a time %s is refused and nothing changes',
    async (_name, when, status, code) => {
      const s = await synced();
      const story = await draftStory(s);
      const res = await schedule(s, story.id, 0, when()).expect(status);
      expect(res.body.code).toBe(code);
      expect(await storyRow(story.id)).toMatchObject({ scheduledAt: null });
      expect(
        await t.probe.find('stories.publish', { storyId: story.id }),
      ).toHaveLength(0);
      expect(await history(story.id)).toEqual(['create']);
    },
  );

  it('S27 AS-43: 365 days ahead is accepted, and an omitted time publishes at once', async () => {
    const s = await synced();
    const story = await draftStory(s);
    await schedule(s, story.id, 0, at(365 * DAY)).expect(200);
    await t.del(s, `${base(s, story.id)}/schedule`).expect(204);
    const now = await t
      .publish(s, story.id, { expectedVersion: 0 })
      .expect(200);
    expect(now.body.status).toBe('PUBLISHED');
  });

  // ------------------------------------------------------------------------------------------------ AS-44

  it('S27 AS-44: the same job delivered twenty times at once publishes once', async () => {
    const s = await synced();
    const story = await draftStory(s);
    const when = at(HOUR);
    await schedule(s, story.id, 0, when).expect(200);
    await t.advance(HOUR);
    await Promise.all(Array.from({ length: 20 }, () => run(story.id, when)));
    expect(await versions(story.id)).toEqual([1]);
    expect(await events(story.id, 'story.published')).toHaveLength(1);
  });

  it('S27 AS-44: publishing now before the time clears the schedule and the job later does nothing', async () => {
    const s = await synced();
    const story = await draftStory(s);
    const when = at(HOUR);
    await schedule(s, story.id, 0, when).expect(200);
    await t.publish(s, story.id, { expectedVersion: 0 }).expect(200);
    expect((await storyRow(story.id)).scheduledAt).toBeNull();
    await t.advance(HOUR);
    await run(story.id, when);
    expect(await versions(story.id)).toEqual([1]);
    expect(await events(story.id, 'story.published')).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------------------------ AS-45

  it('S27 AS-45: a scheduled republish never takes the live version offline', async () => {
    const s = await synced();
    const story = await t.published(s);
    await t
      .saveDraft(s, story.id, 'en', { title: 'Version two' }, 1)
      .expect(200);
    const when = at(HOUR);
    await schedule(s, story.id, 1, when).expect(200);
    expect((await storyRow(story.id)).status).toBe('PUBLISHED');
    const live = await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(200);
    expect(live.body.version).toBe(1);
    await t.advance(HOUR);
    await run(story.id, when);
    const after = await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(200);
    expect(after.body).toMatchObject({ version: 2, title: 'Version two' });
  });

  // ------------------------------------------------------------------------------------------------ AS-46

  it('S27 AS-46: a lost job is published by the sweep within two minutes, once, also when sweeps overlap', async () => {
    const s = await synced();
    const story = await draftStory(s);
    const when = at(HOUR);
    await schedule(s, story.id, 0, when).expect(200);
    await t.advance(HOUR - MINUTE);
    await t.jobs.sweep();
    expect(await versions(story.id)).toEqual([]); // not yet due: untouched
    await t.advance(3 * MINUTE);
    await Promise.all(Array.from({ length: 20 }, () => t.jobs.sweep()));
    expect(await versions(story.id)).toEqual([1]);
    expect(await events(story.id, 'story.published')).toHaveLength(1);
    await t.jobs.sweep();
    expect(await versions(story.id)).toEqual([1]);
  });

  it('S27 AS-46: a schedule cancelled between the sweep’s read and its update is not published', async () => {
    const s = await synced();
    const story = await draftStory(s);
    const when = at(HOUR);
    await schedule(s, story.id, 0, when).expect(200);
    await t.advance(HOUR + MINUTE);
    const original = SequelizeStoryRepository.prototype.claimDue;
    jest
      .spyOn(SequelizeStoryRepository.prototype, 'claimDue')
      .mockImplementation(async function (
        this: SequelizeStoryRepository,
        ...args
      ) {
        const candidates = await original.apply(this, args);
        await t.del(s, `${base(s, story.id)}/schedule`).expect(204);
        return candidates;
      });
    await t.jobs.sweep();
    expect(await versions(story.id)).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------------ AS-47

  describe('S27 AS-47: a failure at fire time', () => {
    const scheduled = async (
      prepare?: (s: Seller, storyId: string) => Promise<void>,
    ) => {
      const s = await synced();
      const p = await t.product(s);
      const story = await t.createStory(s);
      await t
        .saveDraft(s, story.id, 'en', {
          blocks: [{ type: 'product', productId: p.id }],
        })
        .expect(200);
      const when = at(HOUR);
      await schedule(s, story.id, 0, when).expect(200);
      await prepare?.(s, story.id);
      await t.advance(HOUR);
      return { s, story, when, product: p };
    };

    const expectPermanent = async (
      env: Awaited<ReturnType<typeof scheduled>>,
      code: string,
      failedBefore: number,
      liveVersions: number[] = [],
    ) => {
      const { s, story, when } = env;
      await run(story.id, when); // resolves: no retry is asked for
      expect(await versions(story.id)).toEqual(liveVersions);
      const row = await storyRow(story.id);
      expect(row.scheduledAt).toBeNull();
      expect(row.scheduleFailure?.code).toBe(code);
      expect(row.scheduleFailure?.at).toBe(t.clock.now().toISOString());
      const detail = await t.get(s, base(s, story.id)).expect(200);
      expect(
        expectContract(storyAdminSchema, detail.body).scheduleFailure,
      ).toEqual({
        at: t.clock.now().toISOString(),
        code,
      });
      const failed = await events(story.id, 'story.schedule_failed');
      expect(failed).toHaveLength(1);
      expect((failed[0].payload as { payload: unknown }).payload).toEqual({
        storyId: story.id,
        shopId: s.shopId,
        scheduledAt: when,
        code,
      });
      expect(await events(story.id, 'story.published')).toHaveLength(
        liveVersions.length,
      );
      expect(failedCounter()).toBe(failedBefore + 1);
      expect((await history(story.id)).slice(-2)).toEqual([
        'schedule',
        'fire_failed',
      ]);
    };

    it('records a product that no longer exists as unknown_product_reference', async () => {
      const before = failedCounter();
      const env = await scheduled();
      await t.rows(`DELETE FROM "Product" WHERE "id" = :id`, {
        id: env.product.id,
      });
      await expectPermanent(env, 'unknown_product_reference', before);
    });

    it('records a deleted default-locale draft as default_locale_missing', async () => {
      const before = failedCounter();
      const env = await scheduled();
      await t.saveDraft(env.s, env.story.id, 'uk').expect(200);
      await t.rows(
        `DELETE FROM "StoryDraft" WHERE "storyId" = :id AND "locale" = 'en'`,
        { id: env.story.id },
      );
      await expectPermanent(env, 'default_locale_missing', before);
    });

    it('records removed drafts as no_drafts', async () => {
      const before = failedCounter();
      const env = await scheduled();
      await t.rows(`DELETE FROM "StoryDraft" WHERE "storyId" = :id`, {
        id: env.story.id,
      });
      await expectPermanent(env, 'no_drafts', before);
    });

    it('records drafts equal to the live version as nothing_to_publish', async () => {
      const before = failedCounter();
      const s = await synced();
      const story = await t.published(s);
      const when = at(HOUR);
      await schedule(s, story.id, 1, when).expect(200);
      await t.advance(HOUR);
      await expectPermanent(
        { s, story, when, product: { id: '' } },
        'nothing_to_publish',
        before,
        [1],
      );
    });

    it('records a shop that is not active as shop_not_active', async () => {
      const before = failedCounter();
      const env = await scheduled();
      await deliver(
        t.shopCopy,
        shopStatusEvent(env.s.shopId, 'ACTIVE', 'SUSPENDED', 2),
      );
      await expectPermanent(env, 'shop_not_active', before);
    });

    it('retries a transient failure, keeps the schedule, and turns exhausted retries into publish_failed', async () => {
      const before = failedCounter();
      const env = await scheduled();
      jest
        .spyOn(t.app.get(ProductQueryService), 'getProductsByIds')
        .mockRejectedValue(new Error('products unavailable'));
      await expect(run(env.story.id, env.when)).rejects.toBeDefined();
      let row = await storyRow(env.story.id);
      expect(row.scheduledAt?.toISOString()).toBe(env.when);
      expect(row.scheduleFailure).toBeNull();
      expect(await events(env.story.id, 'story.schedule_failed')).toHaveLength(
        0,
      );
      await run(env.story.id, env.when, true);
      row = await storyRow(env.story.id);
      expect(row.scheduledAt).toBeNull();
      expect(row.scheduleFailure?.code).toBe('publish_failed');
      expect(failedCounter()).toBe(before + 1);
      expect(await events(env.story.id, 'story.schedule_failed')).toHaveLength(
        1,
      );
    });

    it('clears the failure with the next schedule or publish', async () => {
      const env = await scheduled();
      await t.rows(`DELETE FROM "StoryDraft" WHERE "storyId" = :id`, {
        id: env.story.id,
      });
      await run(env.story.id, env.when);
      expect((await storyRow(env.story.id)).scheduleFailure).not.toBeNull();
      await t.saveDraft(env.s, env.story.id, 'en', { blocks: [] }).expect(200);
      await schedule(env.s, env.story.id, 0, at(HOUR)).expect(200);
      expect((await storyRow(env.story.id)).scheduleFailure).toBeNull();
      await t.publish(env.s, env.story.id, { expectedVersion: 0 }).expect(200);
      expect((await storyRow(env.story.id)).scheduleFailure).toBeNull();
    });
  });
});
