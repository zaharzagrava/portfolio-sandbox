import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import {
  draftEventSchemas,
  draftPublishResultSchema,
  productEventSchemas,
} from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import {
  createProduct,
  productEvents,
  productIdsOf,
  productRow,
} from '@app/test/utils/catalog-fixtures';
import { waitFor } from '@app/test/utils/async-helpers';
import { DraftsModule } from './drafts.module';
import { CollabModule } from './collab.module';
import { DraftsProjectorModule } from './drafts-projector.module';
import { ProductCommandService } from './application/product-command.service';
import { DraftsJobs } from './infra/drafts.jobs';
import {
  DOC_STORE,
  DRAFT_REPOSITORY,
  RING_REGISTRY,
  SNAPSHOT_STORE,
  type DocStore,
  type DraftRepository,
  type RingRegistry,
  type SnapshotStore,
} from './domain/draft-ports';
import { readListing } from './domain/listing-doc';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';
import {
  VALID_LISTING,
  announceRing,
  draftRow,
  editStored,
  openEditor,
  seedDraft,
  versionRows,
  writeContent,
} from './testing/draft-spec-kit';

const NOW = new Date('2026-03-01T10:00:00.000Z');

describe('Draft publish', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;
  let w: ShopWorld;
  let docs: DocStore;
  let repo: DraftRepository;
  let objects: SnapshotStore;

  const base = () => `/api/shops/${w.shop.id}/drafts`;
  const publish = (
    draftId: string,
    key: string | null = `key-${uuidv7()}`,
    body: object = {},
    user = w.staff,
  ) => {
    const req = t.as(user).post(`${base()}/${draftId}/publish`);
    return (key === null ? req : req.set('Idempotency-Key', key)).send(body);
  };
  const row = <T extends Record<string, unknown>>(id: string) =>
    draftRow<T>(t.app, id);
  const draftEvents = async (draftId: string) =>
    (await outboxRowsFor(t.app, draftId)).filter(
      (r) => r.type === 'catalog.draft_published',
    );
  const productCount = async () =>
    (await productIdsOf(t.app, w.shop.id)).length;
  const newDraft = async (
    content: Parameters<typeof writeContent>[2] = VALID_LISTING,
  ) => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    await writeContent(t.app, draft, content);
    return draft;
  };
  const fromProduct = async (productId: string) =>
    (
      await t
        .as(w.staff)
        .post(base())
        .send({ title: 'rework', productId })
        .expect(201)
    ).body as { id: string; shopId: string };

  beforeAll(async () => {
    t = await createCatalogApp({
      extraImports: [DraftsModule, CollabModule, DraftsProjectorModule],
    });
    sequelize = t.app.get(Sequelize);
    docs = t.app.get<DocStore>(DOC_STORE, { strict: false });
    repo = t.app.get<DraftRepository>(DRAFT_REPOSITORY, { strict: false });
    objects = t.app.get<SnapshotStore>(SNAPSHOT_STORE, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    t.clock.set(NOW);
    w = await createShopWorld(t);
    await announceRing(t.app);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------------------------------------ US4: happy paths

  it('S06 AS-28: publishing a new draft creates the product with every edit the room received just before, a published version with its snapshot, and both events in one transaction; open rooms close with 4005', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    const editor = await openEditor(t, w.staff, w.shop.id, draft.id);
    await editor.whenSynced();
    editor.doc.transact(() => {
      editor.doc.getText('title').insert(0, 'AirPods Pro 3');
      editor.doc.getText('description').insert(0, 'Adaptive audio.');
      const fields = editor.doc.getMap('fields');
      fields.set('priceMinor', 24_900);
      fields.set('brand', 'Apple');
      fields.set('category', 'audio');
      fields.set('quantity', 5);
    });

    // No pause: the room has not flushed yet, the freeze barrier must include the edit.
    const res = await publish(draft.id, 'key-28').expect(200);
    const result = draftPublishResultSchema.parse(res.body);
    expect(result.productVersion).toBe(1);

    const product = await productRow<Record<string, unknown>>(
      t.app,
      result.productId,
    );
    expect(product).toMatchObject({
      shopId: w.shop.id,
      createdBy: w.staff.id,
      title: 'AirPods Pro 3',
      description: 'Adaptive audio.',
      brand: 'Apple',
      category: 'audio',
      status: 'ACTIVE',
      quantity: 5,
    });
    expect(Number(product!.priceMinor)).toBe(24_900);

    const stored = await row<{
      status: string;
      productId: string;
      publishedAt: Date;
      publishLeaseId: string | null;
    }>(draft.id);
    expect(stored).toMatchObject({
      status: 'PUBLISHED',
      productId: result.productId,
      publishLeaseId: null,
    });
    expect(stored!.publishedAt).toEqual(NOW);

    const versions = await versionRows<{
      id: string;
      kind: string;
      name: string;
      objectKey: string;
      createdBy: string;
    }>(t.app, draft.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: result.versionId,
      kind: 'published',
      name: 'Published 2026-03-01 10:00',
      createdBy: w.staff.id,
    });
    const snapshot = new Y.Doc();
    Y.applyUpdate(snapshot, await objects.get(versions[0].objectKey));
    expect(readListing(snapshot)).toMatchObject({
      title: 'AirPods Pro 3',
      priceMinor: 24_900,
    });

    const [published] = await draftEvents(draft.id);
    expect(
      draftEventSchemas['catalog.draft_published'].parse(
        (published.payload as { payload: unknown }).payload,
      ),
    ).toEqual({
      draftId: draft.id,
      shopId: w.shop.id,
      productId: result.productId,
      productVersion: 1,
      versionId: result.versionId,
      publishedBy: w.staff.id,
    });
    const events = await productEvents(t.app, result.productId);
    expect(events.map((e) => e.type)).toEqual(['catalog.product_created']);

    await waitFor(async () => editor.closed !== null, {
      timeoutMs: 5_000,
      description: 'room closed',
    });
    expect(editor.closed!.code).toBe(4005);
  });

  it('S06 AS-29: publishing a draft of a product updates it with its base version and sends only the changed fields', async () => {
    const product = await createProduct(t.app, w.shop, {
      title: 'AirPods',
      description: 'Adaptive audio.',
      brand: 'Apple',
      category: 'audio',
      priceMinor: 20_000,
      quantity: 5,
      version: 7,
    });
    const draft = await fromProduct(product.id);
    await editStored(t.app, draft, (doc) =>
      doc.getMap('fields').set('priceMinor', 21_500),
    );

    const res = await publish(draft.id).expect(200);
    const result = draftPublishResultSchema.parse(res.body);
    expect(result).toMatchObject({ productId: product.id, productVersion: 8 });

    const stored = await productRow<Record<string, unknown>>(t.app, product.id);
    expect(Number(stored!.priceMinor)).toBe(21_500);
    expect(stored).toMatchObject({
      title: 'AirPods',
      brand: 'Apple',
      category: 'audio',
      quantity: 5,
      version: 8,
    });
    const events = await productEvents(t.app, product.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('catalog.product_updated');
    expect(
      productEventSchemas['catalog.product_updated'].parse(events[0].payload)
        .changedFields,
    ).toEqual(['priceMinor']);
    expect((await row<{ status: string }>(draft.id))!.status).toBe('PUBLISHED');
  });

  it('S06 AS-30: a product that changed since the draft started is 409 product_version_conflict; the draft stays editable and nothing is written; acknowledging the current version publishes, a stale acknowledgement is refused again', async () => {
    const product = await createProduct(t.app, w.shop, {
      brand: 'Apple',
      category: 'audio',
      priceMinor: 20_000,
      version: 7,
    });
    const draft = await fromProduct(product.id);
    await editStored(t.app, draft, (doc) =>
      doc.getMap('fields').set('priceMinor', 25_000),
    );
    await sequelize.query(
      `UPDATE "Product" SET "version" = 9 WHERE "id" = :id`,
      { replacements: { id: product.id } },
    );

    const conflict = await publish(draft.id).expect(409);
    expect(conflict.body).toMatchObject({
      code: 'product_version_conflict',
      currentVersion: 9,
    });
    expect((await row<{ status: string }>(draft.id))!.status).toBe('DRAFT');
    expect(
      (await productRow<{ version: number }>(t.app, product.id))!.version,
    ).toBe(9);
    expect(await versionRows(t.app, draft.id)).toHaveLength(0);
    expect(await draftEvents(draft.id)).toHaveLength(0);
    expect(await productEvents(t.app, product.id)).toHaveLength(0);

    // The acknowledged version must be the current one.
    await sequelize.query(
      `UPDATE "Product" SET "version" = 10 WHERE "id" = :id`,
      { replacements: { id: product.id } },
    );
    const stale = await publish(draft.id, undefined, {
      acknowledgeProductVersion: 9,
    }).expect(409);
    expect(stale.body).toMatchObject({
      code: 'product_version_conflict',
      currentVersion: 10,
    });

    const ok = await publish(draft.id, undefined, {
      acknowledgeProductVersion: 10,
    }).expect(200);
    expect(draftPublishResultSchema.parse(ok.body).productVersion).toBe(11);
    expect(
      Number(
        (await productRow<Record<string, unknown>>(t.app, product.id))!
          .priceMinor,
      ),
    ).toBe(25_000);
  });

  // ------------------------------------------------------------------------------------------------- AS-31

  const invalid: [
    string,
    Partial<Parameters<typeof writeContent>[2]>,
    string,
    string,
  ][] = [
    ['an empty title', { title: '' }, 'title', 'invalid'],
    ['a whitespace title', { title: '   ' }, 'title', 'invalid'],
    ['no price', { priceMinor: undefined }, 'priceMinor', 'required'],
    ['a zero price', { priceMinor: 0 }, 'priceMinor', 'invalid'],
    ['a negative price', { priceMinor: -5 }, 'priceMinor', 'invalid'],
    [
      'a price over the limit',
      { priceMinor: 10_000_000_001 },
      'priceMinor',
      'invalid',
    ],
    ['no brand', { brand: undefined }, 'brand', 'required'],
    ['an empty brand', { brand: '' }, 'brand', 'invalid'],
    ['a quantity below zero', { quantity: -1 }, 'quantity', 'invalid'],
    [
      'a quantity over the limit',
      { quantity: 1_000_000_001 },
      'quantity',
      'invalid',
    ],
    [
      'a description over the limit',
      { description: 'd'.repeat(4_001) },
      'description',
      'invalid',
    ],
  ];
  it.each(invalid)(
    'S06 AS-31: %s gives 422 listing_invalid naming the field; the draft returns to DRAFT and nothing is created',
    async (_name, patch, field, code) => {
      const draft = await newDraft({ ...VALID_LISTING, ...patch });
      const res = await publish(draft.id).expect(422);
      expect(res.body.code).toBe('listing_invalid');
      expect(res.body.errors).toEqual([{ field, code }]);
      expect((await row<{ status: string }>(draft.id))!.status).toBe('DRAFT');
      expect(await productCount()).toBe(0);
      expect(await versionRows(t.app, draft.id)).toHaveLength(0);
      expect(await draftEvents(draft.id)).toHaveLength(0);
    },
  );

  it('S06 AS-31: a fractional price is reported invalid, and several problems are all reported', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    await editStored(t.app, draft, (doc) => {
      doc.getMap('fields').set('priceMinor', 12.5);
      doc.getText('title').insert(0, 'ok');
    });
    const res = await publish(draft.id).expect(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        { field: 'priceMinor', code: 'invalid' },
        { field: 'brand', code: 'required' },
      ]),
    );
  });

  it('S06 AS-32: a product archived after the draft started is 409 product_archived, a deleted one 409 product_not_found; the draft stays DRAFT with nothing written', async () => {
    const archived = await createProduct(t.app, w.shop, {
      brand: 'Apple',
      category: 'audio',
      version: 2,
    });
    const gone = await createProduct(t.app, w.shop, {
      brand: 'Apple',
      category: 'audio',
      version: 2,
    });
    const d1 = await fromProduct(archived.id);
    const d2 = await fromProduct(gone.id);
    await sequelize.query(
      `UPDATE "Product" SET "status" = 'ARCHIVED' WHERE "id" = :id`,
      { replacements: { id: archived.id } },
    );
    await sequelize.query(`DELETE FROM "Product" WHERE "id" = :id`, {
      replacements: { id: gone.id },
    });

    expect((await publish(d1.id).expect(409)).body.code).toBe(
      'product_archived',
    );
    expect((await publish(d2.id).expect(409)).body.code).toBe(
      'product_not_found',
    );
    for (const d of [d1, d2]) {
      expect((await row<{ status: string }>(d.id))!.status).toBe('DRAFT');
      expect(await versionRows(t.app, d.id)).toHaveLength(0);
      expect(await draftEvents(d.id)).toHaveLength(0);
    }
  });

  // ------------------------------------------------------------------------------------------ AS-33 idempotency

  describe('idempotency (AS-33)', () => {
    it('S06 AS-33: replaying a completed request returns the same status and body with no second product, version or event', async () => {
      const draft = await newDraft();
      const first = await publish(draft.id, 'key-replay').expect(200);
      const again = await publish(draft.id, 'key-replay').expect(200);
      expect(again.body).toEqual(first.body);
      expect(await productCount()).toBe(1);
      expect(await versionRows(t.app, draft.id)).toHaveLength(1);
      expect(await draftEvents(draft.id)).toHaveLength(1);
    });

    it('S06 AS-33: a request with the same key while the first is still running is 409 request_in_flight', async () => {
      const draft = await newDraft();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const create = t.app
        .get(ProductCommandService)
        .create.bind(t.app.get(ProductCommandService));
      jest
        .spyOn(ProductCommandService.prototype, 'create')
        .mockImplementation(async (...args) => {
          entered();
          await gate;
          return create(...args);
        });
      const running = publish(draft.id, 'key-flight').then((r) => r);
      await inside;
      const twin = await publish(draft.id, 'key-flight').expect(409);
      expect(twin.body.code).toBe('request_in_flight');
      release();
      expect((await running).status).toBe(200);
      expect(await productCount()).toBe(1);
    });

    it('S06 AS-33: the same key with a different body is 422 idempotency_key_reuse', async () => {
      const draft = await newDraft();
      await publish(draft.id, 'key-reuse', {}).expect(200);
      const res = await publish(draft.id, 'key-reuse', {
        acknowledgeProductVersion: 3,
      }).expect(422);
      expect(res.body.code).toBe('idempotency_key_reuse');
    });

    it('S06 AS-33: a missing key is 422 idempotency_key_required, a longer than 128 characters one 422 idempotency_key_invalid', async () => {
      const draft = await newDraft();
      expect((await publish(draft.id, null).expect(422)).body.code).toBe(
        'idempotency_key_required',
      );
      expect(
        (await publish(draft.id, 'k'.repeat(129)).expect(422)).body.code,
      ).toBe('idempotency_key_invalid');
      expect((await row<{ status: string }>(draft.id))!.status).toBe('DRAFT');
    });

    it('S06 AS-33: after 24 hours the key is a new request, and the published draft answers 409 invalid_transition', async () => {
      const draft = await newDraft();
      await publish(draft.id, 'key-ttl').expect(200);
      t.clock.advance(24 * 3600_000 + 1_000);
      await t.reauth(w.staff);
      const res = await publish(draft.id, 'key-ttl').expect(409);
      expect(res.body).toMatchObject({
        code: 'invalid_transition',
        currentStatus: 'PUBLISHED',
      });
    });
  });

  it.each(['PUBLISHED', 'ARCHIVED'] as const)(
    'S06 AS-34: publishing a %s draft with a new key is 409 invalid_transition with currentStatus and changes nothing',
    async (status) => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id, { status });
      const res = await publish(draft.id).expect(409);
      expect(res.body).toMatchObject({
        code: 'invalid_transition',
        currentStatus: status,
      });
      expect((await row<{ status: string }>(draft.id))!.status).toBe(status);
      expect(await productCount()).toBe(0);
    },
  );

  it('S06 AS-34: a draft in PUBLISHING with an unexpired lease is 409 publish_in_progress', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id, {
      status: 'PUBLISHING',
      leaseId: uuidv7(),
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    const res = await publish(draft.id).expect(409);
    expect(res.body.code).toBe('publish_in_progress');
  });

  // ---------------------------------------------------------------------------------------- AS-35 concurrency

  describe('concurrent publish (AS-35)', () => {
    it('S06 AS-35: the same key twice at once gives one product, one version and one event', async () => {
      const draft = await newDraft();
      const calls = await Promise.all([
        publish(draft.id, 'key-twice'),
        publish(draft.id, 'key-twice'),
      ]);
      const statuses = calls.map((c) => c.status).sort();
      expect(statuses[0]).toBe(200);
      expect([200, 409]).toContain(statuses[1]);
      expect(await productCount()).toBe(1);
      expect(await versionRows(t.app, draft.id)).toHaveLength(1);
      expect(await draftEvents(draft.id)).toHaveLength(1);
    });

    it('S06 AS-35: two different keys at once: exactly one 200, the other 409 publish_in_progress or invalid_transition; one product, version and event', async () => {
      const draft = await newDraft();
      const calls = await Promise.all([
        publish(draft.id, 'key-one'),
        publish(draft.id, 'key-two'),
      ]);
      expect(calls.map((c) => c.status).sort()).toEqual([200, 409]);
      const loser = calls.find((c) => c.status === 409)!;
      expect(['publish_in_progress', 'invalid_transition']).toContain(
        loser.body.code,
      );
      expect(await productCount()).toBe(1);
      expect(await versionRows(t.app, draft.id)).toHaveLength(1);
      expect(await draftEvents(draft.id)).toHaveLength(1);
      expect(
        (await productEvents(t.app, (await productIdsOf(t.app, w.shop.id))[0]))
          .length,
      ).toBe(1);
    });

    it('S06 AS-35: two drafts of the same product at once: one succeeds, the other is 409 product_version_conflict', async () => {
      const product = await createProduct(t.app, w.shop, {
        brand: 'Apple',
        category: 'audio',
        priceMinor: 10_000,
        version: 3,
      });
      const a = await fromProduct(product.id);
      const b = await fromProduct(product.id);
      await editStored(t.app, a, (doc) =>
        doc.getMap('fields').set('priceMinor', 11_000),
      );
      await editStored(t.app, b, (doc) =>
        doc.getMap('fields').set('priceMinor', 12_000),
      );
      const calls = await Promise.all([publish(a.id), publish(b.id)]);
      expect(calls.map((c) => c.status).sort()).toEqual([200, 409]);
      expect(calls.find((c) => c.status === 409)!.body.code).toBe(
        'product_version_conflict',
      );
      expect(
        (await productRow<{ version: number }>(t.app, product.id))!.version,
      ).toBe(4);
    });

    it('S06 AS-35: publish and archive of the same draft at once: exactly one wins', async () => {
      const draft = await newDraft();
      const [pub, arch] = await Promise.all([
        publish(draft.id),
        t.as(w.staff).post(`${base()}/${draft.id}/archive`),
      ]);
      expect([pub.status, arch.status].sort()).toEqual([200, 409]);
      const status = (await row<{ status: string }>(draft.id))!.status;
      expect(status).toBe(pub.status === 200 ? 'PUBLISHED' : 'ARCHIVED');
      expect(await productCount()).toBe(pub.status === 200 ? 1 : 0);
    });
  });

  // ------------------------------------------------------------------------------------ AS-36, AS-37

  describe('failure and crash (AS-36, AS-37)', () => {
    const trigger = async (table: string, when: string) => {
      await sequelize.query(`
        CREATE OR REPLACE FUNCTION s06_refuse() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 's06 injected failure'; END $$ LANGUAGE plpgsql;
        DROP TRIGGER IF EXISTS s06_refuse_trigger ON "${table}";
        CREATE TRIGGER s06_refuse_trigger BEFORE ${when} ON "${table}" FOR EACH ROW EXECUTE FUNCTION s06_refuse();`);
      return () =>
        sequelize.query(
          `DROP TRIGGER IF EXISTS s06_refuse_trigger ON "${table}"`,
        );
    };

    it.each([
      ['a failing product update', 'Product', 'UPDATE', true],
      ['a failing event insert', 'Outbox', 'INSERT', false],
    ] as const)(
      'S06 AS-36: %s answers a generic 500, leaves the draft DRAFT and editable before the answer, writes nothing, and a retry with the same key succeeds',
      async (_name, table, when, revision) => {
        let draftId: string;
        if (revision) {
          const product = await createProduct(t.app, w.shop, {
            brand: 'Apple',
            category: 'audio',
            priceMinor: 10_000,
            version: 3,
          });
          draftId = (await fromProduct(product.id)).id;
          await editStored(t.app, { id: draftId, shopId: w.shop.id }, (doc) =>
            doc.getMap('fields').set('priceMinor', 11_000),
          );
        } else draftId = (await newDraft()).id;
        const editor = await openEditor(t, w.staff, w.shop.id, draftId);
        await editor.whenSynced();
        const drop = await trigger(table, when);
        try {
          const res = await publish(draftId, 'key-fail').expect(500);
          expect(JSON.stringify(res.body)).not.toContain('injected');
          expect(res.body.code).toEqual(expect.any(String));
        } finally {
          await drop();
        }
        expect(
          await row<{ status: string; publishLeaseId: string | null }>(draftId),
        ).toMatchObject({
          status: 'DRAFT',
          publishLeaseId: null,
        });
        expect(await versionRows(t.app, draftId)).toHaveLength(0);
        expect(await draftEvents(draftId)).toHaveLength(0);
        if (!revision) expect(await productCount()).toBe(0);

        // The room accepts writes again.
        editor.doc.getText('title').insert(0, 'edited after the failure ');
        await waitFor(async () =>
          (await docs.load(w.shop.id, draftId)).doc
            .getText('title')
            .toString()
            .includes('edited after'),
        );
        expect(editor.closed).toBeNull();

        const retry = await publish(draftId, 'key-fail').expect(200);
        expect(draftPublishResultSchema.safeParse(retry.body).success).toBe(
          true,
        );
      },
    );

    it('S06 AS-37: an expired lease answers publish_in_progress before expiry, is released by the job after it, and a late completion by the old publisher changes nothing', async () => {
      const lease = uuidv7();
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id, {
        status: 'PUBLISHING',
        leaseId: lease,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      });
      expect((await publish(draft.id).expect(409)).body.code).toBe(
        'publish_in_progress',
      );
      const jobs = t.app.get(DraftsJobs);
      expect(await jobs.releaseStalePublishing()).toEqual({ released: 0 });

      t.clock.advance(61_000);
      await t.reauth(w.staff);
      expect(await jobs.releaseStalePublishing()).toEqual({ released: 1 });
      expect(
        await row<{ status: string; publishLeaseId: string | null }>(draft.id),
      ).toMatchObject({
        status: 'DRAFT',
        publishLeaseId: null,
      });

      const late = await repo.transition({
        shopId: w.shop.id,
        draftId: draft.id,
        from: 'PUBLISHING',
        to: 'PUBLISHED',
        leaseId: lease,
        productId: uuidv7(),
        now: t.clock.now(),
      });
      expect(late).toBeNull();
      expect(
        await row<{ status: string; productId: string | null }>(draft.id),
      ).toMatchObject({
        status: 'DRAFT',
        productId: null,
      });
      expect(await productCount()).toBe(0);
      expect(await jobs.releaseStalePublishing()).toEqual({ released: 0 }); // idempotent
    });
  });

  // -------------------------------------------------------------------------------------------------- AS-38

  describe('freeze point (AS-38)', () => {
    it('S06 AS-38: edits received before the freeze are in the product, edits after it are refused with 4005 and not in the product', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const editor = await openEditor(t, w.staff, w.shop.id, draft.id);
      await editor.whenSynced();
      editor.doc.transact(() => {
        editor.doc.getText('title').insert(0, 'Before');
        const fields = editor.doc.getMap('fields');
        fields.set('priceMinor', 100);
        fields.set('brand', 'B');
        fields.set('category', 'c');
      });

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const real = ProductCommandService.prototype.create;
      jest
        .spyOn(ProductCommandService.prototype, 'create')
        .mockImplementation(async function (
          this: ProductCommandService,
          ...args
        ) {
          entered(); // the room is frozen by now
          await gate;
          return real.apply(this, args);
        });
      const running = publish(draft.id).then((r) => r); // a supertest call only starts when it is awaited
      await inside;
      editor.doc.getText('title').insert(0, 'After');
      await waitFor(async () => editor.closed !== null, {
        timeoutMs: 5_000,
        description: 'refused after the freeze',
      });
      expect(editor.closed!.code).toBe(4005);
      release();
      const result = draftPublishResultSchema.parse((await running).body);
      const product = await productRow<{ title: string }>(
        t.app,
        result.productId,
      );
      expect(product!.title).toBe('Before');
    });

    it('S06 AS-38: with no room loaded the stored state is published', async () => {
      const draft = await newDraft();
      const res = await publish(draft.id).expect(200);
      expect(
        (await productRow<{ title: string }>(t.app, res.body.productId))!.title,
      ).toBe('AirPods Pro 3');
    });

    it('S06 AS-38: an owner that does not confirm the freeze within 3 seconds is 503 collab_unavailable, the draft returns to DRAFT and nothing is written', async () => {
      const draft = await newDraft();
      // A listener that accepts the connection and then says nothing: the proxy in front of any live port, set to hang.
      const redisUrl = new URL(
        process.env.REDIS_URL ?? 'redis://localhost:6400/0',
      );
      const proxy = await TcpFaultProxy.start({
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379),
      });
      proxy.mode = 'hang';
      try {
        // The only instance in the ring is one that accepts the call and never answers.
        const redis = t.app.get(RedisService).client;
        await redis.del('collab:ring');
        await redis.zadd(
          'collab:ring',
          t.clock.nowMs(),
          `ghost|ws://127.0.0.1:${proxy.port}`,
        );
        await t.app.get<RingRegistry>(RING_REGISTRY).refreshNow();
        const started = Date.now();
        const res = await publish(draft.id).expect(503);
        expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
        expect(res.body.code).toBe('collab_unavailable');
      } finally {
        proxy.mode = 'pass';
        await proxy.close();
      }
      expect((await row<{ status: string }>(draft.id))!.status).toBe('DRAFT');
      expect(await productCount()).toBe(0);
      expect(await versionRows(t.app, draft.id)).toHaveLength(0);
    }, 30_000);
  });

  // -------------------------------------------------------------------------------------------------- AS-39

  it('S06 AS-39: the spec table is rendered into the description, parsed back into a new draft, and publishing that draft unchanged changes no product field', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    await writeContent(t.app, draft, {
      ...VALID_LISTING,
      description: 'Adaptive audio.',
      specs: { Storage: '256 GB', Color: 'Black' },
    });
    const first = draftPublishResultSchema.parse(
      (await publish(draft.id).expect(200)).body,
    );
    const published = await productRow<{
      description: string;
      version: number;
    }>(t.app, first.productId);
    expect(published!.description).toBe(
      'Adaptive audio.\n\nSpecifications\n- Color: Black\n- Storage: 256 GB',
    );

    const second = await fromProduct(first.productId);
    const loaded = (await docs.load(w.shop.id, second.id)).doc;
    expect(readListing(loaded)).toMatchObject({
      description: 'Adaptive audio.',
      specs: { Storage: '256 GB', Color: 'Black' },
    });

    const before = (await productEvents(t.app, first.productId)).length;
    const again = draftPublishResultSchema.parse(
      (await publish(second.id).expect(200)).body,
    );
    expect(again).toMatchObject({
      productId: first.productId,
      productVersion: first.productVersion,
    });
    const after = await productRow<{ description: string; version: number }>(
      t.app,
      first.productId,
    );
    expect(after).toMatchObject({
      description: published!.description,
      version: published!.version,
    });
    expect(await productEvents(t.app, first.productId)).toHaveLength(before); // S05 wrote no event
    expect((await row<{ status: string }>(second.id))!.status).toBe(
      'PUBLISHED',
    );
    // The draft was still published: its own event names the unchanged product version.
    const [event] = await draftEvents(second.id);
    expect(
      draftEventSchemas['catalog.draft_published'].parse(
        (event.payload as { payload: unknown }).payload,
      ),
    ).toMatchObject({
      draftId: second.id,
      productId: first.productId,
      productVersion: first.productVersion,
    });
  });
});
