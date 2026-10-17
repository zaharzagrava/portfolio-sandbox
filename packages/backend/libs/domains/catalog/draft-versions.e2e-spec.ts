import * as Y from 'yjs';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import {
  draftVersionDetailSchema,
  draftVersionPageSchema,
  draftVersionSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { waitFor } from '@app/test/utils/async-helpers';
import { DraftsModule } from './drafts.module';
import { CollabModule } from './collab.module';
import { SNAPSHOT_STORE, type SnapshotStore } from './domain/draft-ports';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import {
  createShopWorld,
  stableProblem,
  type ShopWorld,
} from './testing/catalog-spec-kit';
import {
  announceRing,
  editStored,
  openEditor,
  seedDraft,
  seedVersion,
  versionRows,
} from './testing/draft-spec-kit';

const NOW = new Date('2026-03-01T10:00:00.000Z');

describe('Draft version history', () => {
  let t: CatalogTestApp;
  let w: ShopWorld;
  let objects: SnapshotStore;

  const base = () => `/api/shops/${w.shop.id}/drafts`;
  const create = (draftId: string, body: unknown, user = w.staff) =>
    t
      .as(user)
      .post(`${base()}/${draftId}/versions`)
      .send(body as object);

  beforeAll(async () => {
    t = await createCatalogApp({ extraImports: [DraftsModule, CollabModule] });
    objects = t.app.get<SnapshotStore>(SNAPSHOT_STORE, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    t.clock.set(NOW);
    w = await createShopWorld(t);
    await announceRing(t.app);
  });
  afterEach(() => jest.restoreAllMocks());

  it('S06 AS-40: a named version holds every edit the room received just before the call, has no content in its answer, and later edits never change it', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    const editor = await openEditor(t, w.staff, w.shop.id, draft.id);
    await editor.whenSynced();
    editor.doc.getText('title').insert(0, 'Before price change');
    editor.doc.getMap('fields').set('priceMinor', 19_900);

    // No pause: the room has not flushed these edits yet, the barrier must.
    const res = await create(draft.id, { name: 'Before price change' }).expect(
      201,
    );
    const version = draftVersionSchema.parse(res.body);
    expect(version).toMatchObject({
      name: 'Before price change',
      kind: 'named',
      createdBy: w.staff.id,
    });
    expect(res.body.content).toBeUndefined();
    expect(version.createdAt).toBe(NOW.toISOString());

    editor.doc.getText('title').insert(0, 'LATER ');
    editor.doc.getMap('fields').set('priceMinor', 99_999);
    await new Promise((r) => setTimeout(r, 300));

    const read = await t
      .as(w.viewer)
      .get(`${base()}/${draft.id}/versions/${version.id}`)
      .expect(200);
    const detail = draftVersionDetailSchema.parse(read.body);
    expect(detail.content).toMatchObject({
      title: 'Before price change',
      priceMinor: 19_900,
    });
    expect(detail.id).toBe(version.id);
  });

  const badNames: [string, unknown][] = [
    ['an empty name', ''],
    ['a blank name', '   '],
    ['an 81 character name', 'n'.repeat(81)],
    ['a name with a control character', 'bad\u0007name'],
    ['a name that is not a string', 7],
  ];
  it.each(badNames)(
    'S06 AS-41: %s gives 400 validation_failed and writes nothing',
    async (_name, name) => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const res = await create(draft.id, { name }).expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(await versionRows(t.app, draft.id)).toHaveLength(0);
    },
  );

  it('S06 AS-41: an unknown field is refused, an 80 character name is accepted', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    expect(
      (await create(draft.id, { name: 'ok', kind: 'published' }).expect(400))
        .body.code,
    ).toBe('validation_failed');
    await create(draft.id, { name: 'n'.repeat(80) }).expect(201);
  });

  it('S06 AS-41: the 201st version is 409 version_limit_reached and writes no row or object', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    await t.app.get(Sequelize).query(
      `INSERT INTO "ListingDraftVersion" ("id","draftId","shopId","name","kind","objectKey","createdBy","createdAt")
       SELECT uuidv7(), :d, :s, 'v' || g, 'named', 'versions/none-' || g, :u, now() FROM generate_series(1, 200) g`,
      { replacements: { d: draft.id, s: w.shop.id, u: w.owner.id } },
    );
    const before = (await objects.list('versions/')).length;
    const res = await create(draft.id, { name: 'one too many' }).expect(409);
    expect(res.body.code).toBe('version_limit_reached');
    expect(await versionRows(t.app, draft.id)).toHaveLength(200);
    expect((await objects.list('versions/')).length).toBe(before);
  });

  it.each(['PUBLISHED', 'ARCHIVED', 'PUBLISHING'] as const)(
    'S06 AS-41: a version of a %s draft is 409 invalid_transition',
    async (status) => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id, {
        status,
        leaseId: status === 'PUBLISHING' ? uuidv7() : null,
        leaseExpiresAt:
          status === 'PUBLISHING' ? new Date(NOW.getTime() + 60_000) : null,
      });
      const res = await create(draft.id, { name: 'late' }).expect(409);
      expect(res.body).toMatchObject({
        code: 'invalid_transition',
        currentStatus: status,
      });
      expect(await versionRows(t.app, draft.id)).toHaveLength(0);
    },
  );

  it('S06 AS-41: a read-only member is 403 permission_denied and writes nothing', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    const res = await create(draft.id, { name: 'nope' }, w.viewer).expect(403);
    expect(res.body.code).toBe('permission_denied');
    expect(await versionRows(t.app, draft.id)).toHaveLength(0);
  });

  it('S06 AS-42: the list is a keyset page, newest first with the id as tie-breaker, with kind and an opaque cursor, and a cursor of another draft or a bad limit is refused', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    const other = await seedDraft(t.app, w.shop.id, w.owner.id);
    const ids: string[] = [];
    for (let i = 0; i < 45; i++)
      ids.push(
        await seedVersion(t.app, draft, w.owner.id, {
          kind: i % 9 === 0 ? 'published' : 'named',
          createdAt: new Date(NOW.getTime() - Math.floor(i / 3) * 1000), // ties of three
          content: false,
        }),
      );
    await seedVersion(t.app, other, w.owner.id, { content: false });

    const pages: ReturnType<typeof draftVersionPageSchema.parse>[] = [];
    let cursor: string | null = null;
    do {
      const res = await t
        .as(w.viewer)
        .get(
          `${base()}/${draft.id}/versions?limit=20${cursor ? `&cursor=${cursor}` : ''}`,
        )
        .expect(200);
      const page = draftVersionPageSchema.parse(res.body);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages.map((p) => p.items.length)).toEqual([20, 20, 5]);
    const listed = pages.flatMap((p) => p.items);
    expect(new Set(listed.map((v) => v.id)).size).toBe(45);
    expect(listed.every((v) => ['named', 'published'].includes(v.kind))).toBe(
      true,
    );
    expect(listed.some((v) => v.kind === 'published')).toBe(true);
    const expected = (await versionRows<{ id: string }>(t.app, draft.id)).sort(
      (a, b) =>
        (b as unknown as { createdAt: Date }).createdAt.getTime() -
          (a as unknown as { createdAt: Date }).createdAt.getTime() ||
        (b.id < a.id ? -1 : 1),
    );
    expect(listed.map((v) => v.id)).toEqual(expected.map((v) => v.id));

    const foreign = draftVersionPageSchema.parse(
      (
        await t
          .as(w.viewer)
          .get(`${base()}/${other.id}/versions?limit=1`)
          .expect(200)
      ).body,
    );
    await seedVersion(t.app, other, w.owner.id, { content: false });
    const again = draftVersionPageSchema.parse(
      (
        await t
          .as(w.viewer)
          .get(`${base()}/${other.id}/versions?limit=1`)
          .expect(200)
      ).body,
    );
    const crossed = await t
      .as(w.viewer)
      .get(
        `${base()}/${draft.id}/versions?cursor=${again.nextCursor ?? foreign.nextCursor}`,
      )
      .expect(400);
    expect(crossed.body.code).toBe('invalid_cursor');
    for (const query of ['limit=0', 'limit=101', 'limit=abc'])
      expect(
        (
          await t
            .as(w.viewer)
            .get(`${base()}/${draft.id}/versions?${query}`)
            .expect(400)
        ).body.code,
      ).toBe('validation_failed');
  });

  it('S06 AS-43: a version reads back with its content; an unknown id, the version of another draft and the version of a draft of another shop are the same 404 version_not_found', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    const sibling = await seedDraft(t.app, w.shop.id, w.owner.id);
    const state = new Y.Doc();
    state.getText('title').insert(0, 'Stored');
    state.getText('description').insert(0, 'About it');
    state.getMap('fields').set('priceMinor', 1_500);
    state.getMap('fields').set('brand', 'Acme');
    state.getMap('specs').set('Color', 'Black');
    const versionId = await seedVersion(t.app, draft, w.owner.id, {
      name: 'Seeded',
      content: state,
    });

    const res = await t
      .as(w.viewer)
      .get(`${base()}/${draft.id}/versions/${versionId}`)
      .expect(200);
    expect(draftVersionDetailSchema.parse(res.body)).toMatchObject({
      id: versionId,
      name: 'Seeded',
      kind: 'named',
      content: {
        title: 'Stored',
        description: 'About it',
        priceMinor: 1_500,
        brand: 'Acme',
        category: null,
        quantity: null,
        specs: { Color: 'Black' },
      },
    });

    const otherShop = await createShop(t.app, w.owner);
    const foreignDraft = await seedDraft(t.app, otherShop.id, w.owner.id);
    const foreignVersion = await seedVersion(t.app, foreignDraft, w.owner.id);
    const unknown = await t
      .as(w.viewer)
      .get(`${base()}/${draft.id}/versions/${uuidv7()}`)
      .expect(404);
    for (const id of [versionId, foreignVersion]) {
      const res404 = await t
        .as(w.viewer)
        .get(`${base()}/${sibling.id}/versions/${id}`)
        .expect(404);
      expect(res404.body.code).toBe('version_not_found');
      expect(stableProblem(res404.body)).toEqual(stableProblem(unknown.body));
    }
    const viaOtherShop = await t
      .as(w.viewer)
      .get(`${base()}/${draft.id}/versions/${foreignVersion}`)
      .expect(404);
    expect(viaOtherShop.body.code).toBe('version_not_found');
  });

  it('S06 AS-44: when the object store fails or the snapshot is missing the read is 503 version_unavailable with Retry-After and a generic detail, counted in a metric; other routes keep working', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    const versionId = await seedVersion(t.app, draft, w.owner.id);
    const before =
      MetricsRegistry.value('drafts_version_unavailable_total') ?? 0;

    jest.spyOn(objects, 'get').mockRejectedValueOnce(
      Object.assign(new Error('S3 secret endpoint minio:9000 AccessDenied'), {
        stack: 'at secret.ts:1',
      }),
    );
    const failed = await t
      .as(w.viewer)
      .get(`${base()}/${draft.id}/versions/${versionId}`)
      .expect(503);
    expect(failed.body.code).toBe('version_unavailable');
    expect(Number(failed.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.stringify(failed.body)).not.toMatch(
      /S3|minio|AccessDenied|secret|at .*\.ts/,
    );

    await objects.delete(`versions/${versionId}`); // a missing snapshot
    const missing = await t
      .as(w.viewer)
      .get(`${base()}/${draft.id}/versions/${versionId}`)
      .expect(503);
    expect(missing.body.code).toBe('version_unavailable');
    expect(MetricsRegistry.value('drafts_version_unavailable_total')).toBe(
      before + 2,
    );

    await t.as(w.viewer).get(`${base()}/${draft.id}/versions`).expect(200);
    await t.as(w.viewer).get(base()).expect(200);
    await editStored(t.app, draft, (doc) =>
      doc.getText('title').insert(0, 'still editable'),
    );
    await create(draft.id, { name: 'after the outage' }).expect(201);
    await waitFor(
      async () => (await versionRows(t.app, draft.id)).length === 2,
    );
  });
});
