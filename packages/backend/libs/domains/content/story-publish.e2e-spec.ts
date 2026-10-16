import { ProductQueryService } from '@app/domains/catalog';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { storyPublishResultSchema } from '@marketplace-sandbox/contracts';
import {
  createStoryApp,
  expectContract,
  type Seller,
  type StoryTestApp,
} from './testing/story-client';

const DAY = 24 * 3_600_000;

describe('Brand stories: publish, versions, optimistic concurrency and idempotent replay', () => {
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

  const base = (s: Seller, storyId: string) =>
    `/api/shops/${s.shopId}/stories/${storyId}`;
  const versionRows = (storyId: string) =>
    t.rows<{
      version: number;
      locale: string;
      title: string;
      blocks: unknown;
      seo: unknown;
      publishedBy: string | null;
    }>(
      `SELECT "version", "locale", "title", "blocks", "seo", "publishedBy" FROM "StoryVersion"
        WHERE "storyId" = :storyId ORDER BY "version", "locale"`,
      { storyId },
    );
  const storyRow = async (storyId: string) =>
    (
      await t.rows<{
        status: string;
        publishedVersion: number | null;
        publishedAt: Date | null;
        scheduledAt: Date | null;
        sitemapPosition: string | null;
      }>(
        `SELECT "status", "publishedVersion", "publishedAt", "scheduledAt", "sitemapPosition" FROM "Story" WHERE "id" = :storyId`,
        { storyId },
      )
    )[0];
  const history = (storyId: string) =>
    t.rows<{
      action: string;
      from: string | null;
      to: string;
      actor: string | null;
    }>(
      `SELECT "action", "from", "to", "actor" FROM "StoryTransition" WHERE "storyId" = :storyId ORDER BY "occurredAt", "id"`,
      { storyId },
    );
  const nothingPersisted = async (storyId: string) => {
    expect(await versionRows(storyId)).toHaveLength(0);
    expect(await t.outbox(storyId)).toHaveLength(0);
    expect((await storyRow(storyId)).status).toBe('DRAFT');
    expect((await history(storyId)).map((h) => h.action)).toEqual(['create']);
  };

  // ------------------------------------------------------------------------------------------------ AS-20

  it('S27 AS-20: publishing freezes the drafts into version 1, with the pointer, history and event in one transaction', async () => {
    const s = await t.seller();
    await t.syncShop(s);
    const product = await t.product(s);
    const story = await t.createStory(s, 'inside-iphone-18');
    const blocks = [
      { type: 'heading', level: 2, text: 'Design' },
      { type: 'product', productId: product.id },
    ];
    await t
      .saveDraft(s, story.id, 'en', {
        title: 'Inside',
        blocks,
        seo: { description: 'd' },
      })
      .expect(200);
    await t
      .saveDraft(s, story.id, 'uk', { title: 'Всередині', blocks })
      .expect(200);
    await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(404);

    const res = await t
      .publish(s, story.id, { expectedVersion: 0 }, 'key-0001-ab')
      .expect(200);
    expect(expectContract(storyPublishResultSchema, res.body)).toEqual({
      status: 'PUBLISHED',
      version: 1,
      locales: ['en', 'uk'],
      publishedAt: t.clock.now().toISOString(),
      scheduledAt: null,
    });

    const rows = await versionRows(story.id);
    expect(rows.map((r) => [r.version, r.locale, r.title])).toEqual([
      [1, 'en', 'Inside'],
      [1, 'uk', 'Всередині'],
    ]);
    expect(rows[0].blocks).toEqual(blocks);
    expect(rows[0].seo).toEqual({ description: 'd' });
    expect(rows.every((r) => r.publishedBy === s.id)).toBe(true);
    const row = await storyRow(story.id);
    expect(row).toMatchObject({
      status: 'PUBLISHED',
      publishedVersion: 1,
      scheduledAt: null,
    });
    expect(row.publishedAt?.toISOString()).toBe(t.clock.now().toISOString());
    expect(row.sitemapPosition).not.toBeNull();
    expect(await history(story.id)).toEqual([
      { action: 'create', from: null, to: 'DRAFT', actor: s.id },
      { action: 'publish', from: 'DRAFT', to: 'PUBLISHED', actor: s.id },
    ]);
    const events = await t.outbox(story.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'event',
      topic: 'stories.events',
      type: 'story.published',
      aggregateId: story.id,
    });
    expect(events[0].payload).toMatchObject({
      eventId: expect.any(String),
      type: 'story.published',
      version: 1,
      occurredAt: t.clock.now().toISOString(),
      aggregateId: story.id,
      payload: {
        storyId: story.id,
        shopId: s.shopId,
        shopSlug: s.shopSlug,
        slug: 'inside-iphone-18',
        version: 1,
        locales: ['en', 'uk'],
      },
    });
    // the drafts stay and stay editable
    const detail = await t.get(s, base(s, story.id)).expect(200);
    expect(detail.body.drafts.map((d: { locale: string }) => d.locale)).toEqual(
      ['en', 'uk'],
    );
    await t.saveDraft(s, story.id, 'en', { title: 'Inside 2' }, 1).expect(200);
    await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(200);
  });

  // ------------------------------------------------------------------------------------------------ AS-21

  it('S27 AS-21: editing after a publish changes nothing public; republishing makes version 2 and leaves version 1 intact', async () => {
    const s = await t.seller();
    await t.syncShop(s);
    const story = await t.published(s);
    const url = `/api/stories/${s.shopSlug}/${story.slug}/en`;
    const live = await t.http().get(url).expect(200);
    const v1 = await versionRows(story.id);

    await t.saveDraft(s, story.id, 'en', { title: 'Changed' }, 1).expect(200);
    const unchanged = await t.http().get(url).expect(200);
    expect(unchanged.body).toEqual(live.body);
    expect(unchanged.headers.etag).toBe(live.headers.etag);
    const detail = await t.get(s, base(s, story.id)).expect(200);
    expect(detail.body.publishedVersion).toBe(1);
    expect(detail.body.drafts[0].title).toBe('Changed');

    const second = await t
      .publish(s, story.id, { expectedVersion: 1 })
      .expect(200);
    expect(second.body.version).toBe(2);
    const now = await t.http().get(url).expect(200);
    expect(now.body.version).toBe(2);
    expect(now.body.title).toBe('Changed');
    expect(now.headers.etag).not.toBe(live.headers.etag);
    const rows = await versionRows(story.id);
    expect(rows.filter((r) => r.version === 1)).toEqual(v1);
    expect(rows.filter((r) => r.version === 2)).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------------------------ AS-22

  describe('S27 AS-22: a draft set that cannot be published writes nothing', () => {
    it('refuses a story with no drafts: 422 no_drafts', async () => {
      const s = await t.seller();
      const story = await t.createStory(s);
      const res = await t
        .publish(s, story.id, { expectedVersion: 0 })
        .expect(422);
      expect(res.body.code).toBe('no_drafts');
      await nothingPersisted(story.id);
    });

    it('refuses drafts without the default locale: 422 default_locale_missing', async () => {
      const s = await t.seller();
      const story = await t.createStory(s, 'uk-default', 'uk');
      await t.saveDraft(s, story.id, 'en').expect(200);
      const res = await t
        .publish(s, story.id, { expectedVersion: 0 })
        .expect(422);
      expect(res.body.code).toBe('default_locale_missing');
      await nothingPersisted(story.id);
    });

    it('refuses drafts equal to the live version: 409 nothing_to_publish, and publishes again after an edit', async () => {
      const s = await t.seller();
      const story = await t.published(s);
      const res = await t
        .publish(s, story.id, { expectedVersion: 1 })
        .expect(409);
      expect(res.body.code).toBe('nothing_to_publish');
      expect(await versionRows(story.id)).toHaveLength(1);
      expect(await t.outbox(story.id)).toHaveLength(1);
      await t.saveDraft(s, story.id, 'en', { title: 'Edited' }, 1).expect(200);
      await t.publish(s, story.id, { expectedVersion: 1 }).expect(200);
    });

    it('refuses a product that does not exist or belongs to another shop, indistinguishably: 422 unknown_product_reference', async () => {
      const s = await t.seller();
      const other = await t.seller();
      const foreign = await t.product(other);
      const missing = '0192a000-0000-7000-8000-000000000000';
      const story = await t.createStory(s);
      await t
        .saveDraft(s, story.id, 'en', {
          blocks: [
            { type: 'product', productId: foreign.id },
            { type: 'product', productId: missing },
          ],
        })
        .expect(200);
      const res = await t
        .publish(s, story.id, { expectedVersion: 0 })
        .expect(422);
      expect(res.body.code).toBe('unknown_product_reference');
      expect([...res.body.productIds].sort()).toEqual(
        [foreign.id, missing].sort(),
      );
      await nothingPersisted(story.id);
    });

    it('asks S05 once, with the shop, for all the distinct product ids of all locales', async () => {
      const s = await t.seller();
      const a = await t.product(s);
      const b = await t.product(s);
      const story = await t.createStory(s);
      const spy = jest.spyOn(
        t.app.get(ProductQueryService),
        'getProductsByIds',
      );
      await t
        .saveDraft(s, story.id, 'en', {
          blocks: [
            { type: 'product', productId: a.id },
            { type: 'product', productId: a.id },
          ],
        })
        .expect(200);
      await t
        .saveDraft(s, story.id, 'uk', {
          blocks: [{ type: 'product', productId: b.id }],
        })
        .expect(200);
      await t.publish(s, story.id, { expectedVersion: 0 }).expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const [ids, options] = spy.mock.calls[0];
      expect([...ids].sort()).toEqual([a.id, b.id].sort());
      expect(options).toEqual({ shopId: s.shopId });
    });

    it('accepts an archived product', async () => {
      const s = await t.seller();
      const archived = await createProduct(
        t.app,
        { id: s.shopId },
        { status: 'ARCHIVED' },
      );
      const story = await t.createStory(s);
      await t
        .saveDraft(s, story.id, 'en', {
          blocks: [{ type: 'product', productId: archived.id }],
        })
        .expect(200);
      await t.publish(s, story.id, { expectedVersion: 0 }).expect(200);
    });

    it('answers 503 dependency_unavailable with Retry-After when S05 fails, and writes nothing', async () => {
      const s = await t.seller();
      const p = await t.product(s);
      const story = await t.createStory(s);
      await t
        .saveDraft(s, story.id, 'en', {
          blocks: [{ type: 'product', productId: p.id }],
        })
        .expect(200);
      jest
        .spyOn(t.app.get(ProductQueryService), 'getProductsByIds')
        .mockRejectedValue(
          new Error('connect ECONNREFUSED 10.1.2.3:5432 products-db'),
        );
      const res = await t
        .publish(s, story.id, { expectedVersion: 0 })
        .expect(503);
      expect(res.body.code).toBe('dependency_unavailable');
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.text).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|products-db/);
      await nothingPersisted(story.id);
    });

    it('answers 503 when S05 does not answer within its timeout', async () => {
      const s = await t.seller();
      const p = await t.product(s);
      const story = await t.createStory(s);
      await t
        .saveDraft(s, story.id, 'en', {
          blocks: [{ type: 'product', productId: p.id }],
        })
        .expect(200);
      t.config.dependencyTimeoutMs = 150;
      try {
        jest
          .spyOn(t.app.get(ProductQueryService), 'getProductsByIds')
          .mockImplementation(() => new Promise(() => undefined));
        const started = Date.now();
        const res = await t
          .publish(s, story.id, { expectedVersion: 0 })
          .expect(503);
        expect(res.body.code).toBe('dependency_unavailable');
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        t.config.dependencyTimeoutMs = 2_000;
      }
      await nothingPersisted(story.id);
    });
  });

  // ------------------------------------------------------------------------------------------------ AS-23

  it('S27 AS-23: two publishes of version 0 at once give one 200 and one 409 version_conflict, one version and one event', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    await t.saveDraft(s, story.id, 'en').expect(200);
    const [a, b] = await Promise.all([
      t.publish(s, story.id, { expectedVersion: 0 }, 'key-race-0001'),
      t.publish(s, story.id, { expectedVersion: 0 }, 'key-race-0002'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body).toMatchObject({
      code: 'version_conflict',
      currentVersion: 1,
    });
    expect(await versionRows(story.id)).toHaveLength(1);
    expect(await t.outbox(story.id)).toHaveLength(1);
  });

  it('S27 AS-23: twenty concurrent publishes give one success and gapless versions', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    await t.saveDraft(s, story.id, 'en').expect(200);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        t.publish(
          s,
          story.id,
          { expectedVersion: 0 },
          `key-flood-${String(i).padStart(4, '0')}`,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect((await versionRows(story.id)).map((r) => r.version)).toEqual([1]);
    expect(await t.outbox(story.id)).toHaveLength(1);
  });

  it('S27 AS-23: a stale expectedVersion is 409 and changes nothing; a missing one is 400', async () => {
    const s = await t.seller();
    const story = await t.published(s);
    await t.saveDraft(s, story.id, 'en', { title: 'next' }, 1).expect(200);
    const stale = await t
      .publish(s, story.id, { expectedVersion: 0 })
      .expect(409);
    expect(stale.body).toMatchObject({
      code: 'version_conflict',
      currentVersion: 1,
    });
    expect(await versionRows(story.id)).toHaveLength(1);
    const missing = await t
      .http()
      .post(`${base(s, story.id)}/publish`)
      .set(s.auth)
      .set('Idempotency-Key', 'key-missing-v1')
      .send({})
      .expect(400);
    expect(missing.body.code).toBe('validation_failed');
  });

  // ------------------------------------------------------------------------------------------------ AS-24

  describe('S27 AS-24: Idempotency-Key', () => {
    it('replays the stored answer byte for byte and creates nothing new', async () => {
      const s = await t.seller();
      const story = await t.createStory(s);
      await t.saveDraft(s, story.id, 'en').expect(200);
      const first = await t
        .publish(s, story.id, { expectedVersion: 0 }, 'key-replay-01')
        .expect(200);
      expect(first.headers['idempotency-replayed']).toBeUndefined();
      const again = await t
        .publish(s, story.id, { expectedVersion: 0 }, 'key-replay-01')
        .expect(200);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.text).toBe(first.text);
      expect(await versionRows(story.id)).toHaveLength(1);
      expect(await t.outbox(story.id)).toHaveLength(1);
      expect(await history(story.id)).toHaveLength(2);
      expect(
        await t.probe.find('stories.publish', { storyId: story.id }),
      ).toHaveLength(0);
    });

    it('answers 409 idempotency_in_flight with Retry-After while the first request still runs', async () => {
      const s = await t.seller();
      const p = await t.product(s);
      const story = await t.createStory(s);
      await t
        .saveDraft(s, story.id, 'en', {
          blocks: [{ type: 'product', productId: p.id }],
        })
        .expect(200);
      const service = t.app.get(ProductQueryService);
      const real = service.getProductsByIds.bind(service);
      jest
        .spyOn(service, 'getProductsByIds')
        .mockImplementation(async (ids, options) => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          return real(ids, options);
        });
      const first = t
        .publish(s, story.id, { expectedVersion: 0 }, 'key-slow-0001')
        .then((r) => r);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = await t
        .publish(s, story.id, { expectedVersion: 0 }, 'key-slow-0001')
        .expect(409);
      expect(second.body.code).toBe('idempotency_in_flight');
      expect(second.headers['retry-after']).toBe('1');
      expect((await first).status).toBe(200);
      expect(await versionRows(story.id)).toHaveLength(1);
    });

    it('answers 422 idempotency_key_reuse for the same key with another body', async () => {
      const s = await t.seller();
      const story = await t.createStory(s);
      await t.saveDraft(s, story.id, 'en').expect(200);
      await t
        .publish(s, story.id, { expectedVersion: 0 }, 'key-reuse-001')
        .expect(200);
      const res = await t
        .publish(s, story.id, { expectedVersion: 1 }, 'key-reuse-001')
        .expect(422);
      expect(res.body.code).toBe('idempotency_key_reuse');
    });

    it.each([
      ['missing', undefined, 'idempotency_key_required'],
      ['too short', 'short', 'idempotency_key_invalid'],
      ['with a space', 'has a space in it', 'idempotency_key_invalid'],
      ['too long', 'k'.repeat(129), 'idempotency_key_invalid'],
    ])('answers 422 for a key that is %s', async (_name, key, code) => {
      const s = await t.seller();
      const story = await t.createStory(s);
      await t.saveDraft(s, story.id, 'en').expect(200);
      const req = t
        .http()
        .post(`${base(s, story.id)}/publish`)
        .set(s.auth);
      if (key !== undefined) req.set('Idempotency-Key', key);
      const res = await req.send({ expectedVersion: 0 }).expect(422);
      expect(res.body.code).toBe(code);
      expect(await versionRows(story.id)).toHaveLength(0);
    });

    it('treats the key as new after 24 hours and 1 second, and scopes keys per shop', async () => {
      const s = await t.seller();
      const story = await t.createStory(s);
      await t.saveDraft(s, story.id, 'en').expect(200);
      await t
        .publish(s, story.id, { expectedVersion: 0 }, 'key-expire-001')
        .expect(200);
      await t.advance(DAY + 1_000);
      const res = await t
        .publish(s, story.id, { expectedVersion: 0 }, 'key-expire-001')
        .expect(409);
      expect(res.body.code).toBe('version_conflict');

      const a = await t.seller();
      const b = await t.seller();
      const sa = await t.createStory(a);
      const sb = await t.createStory(b);
      await t.saveDraft(a, sa.id, 'en').expect(200);
      await t.saveDraft(b, sb.id, 'en').expect(200);
      await t
        .publish(a, sa.id, { expectedVersion: 0 }, 'shared-key-0001')
        .expect(200);
      const other = await t
        .publish(b, sb.id, { expectedVersion: 0 }, 'shared-key-0001')
        .expect(200);
      expect(other.headers['idempotency-replayed']).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------------------------------------ AS-95

  it('S27 AS-95: a store failure while publishing leaves no version, pointer, history or event, and answers a generic 5xx', async () => {
    const s = await t.seller();
    const story = await t.createStory(s);
    await t.saveDraft(s, story.id, 'en').expect(200);
    // the outbox write is the last step of the transaction: its failure must roll back everything before it
    jest
      .spyOn(t.app.get(OutboxService), 'append')
      .mockRejectedValue(
        new Error('relation "Outbox" does not exist at db-host-7'),
      );
    const res = await t
      .publish(s, story.id, { expectedVersion: 0 })
      .expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.text).not.toMatch(/Outbox|db-host-7|relation/);
    expect(
      res.body.requestId ?? res.body.instance ?? res.headers['x-request-id'],
    ).toBeDefined();
    jest.restoreAllMocks();
    await nothingPersisted(story.id);
    expect(storyRowAfter(await storyRow(story.id))).toBe(true);
  });

  const storyRowAfter = (row: {
    publishedVersion: number | null;
    sitemapPosition: string | null;
  }) => row.publishedVersion === null && row.sitemapPosition === null;
});
