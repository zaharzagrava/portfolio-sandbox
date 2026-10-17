import * as Y from 'yjs';
import { waitFor } from '@app/test/utils/async-helpers';
import { YClient } from '@app/test/fakes/y-client';
import { CollabModule } from './collab.module';
import { DraftsModule } from './drafts.module';
import { DraftsProjectorModule } from './drafts-projector.module';
import { DOC_STORE, type DocStore } from './domain/draft-ports';
import { readListing } from './domain/listing-doc';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';
import { productRow } from '@app/test/utils/catalog-fixtures';
import {
  announceRing,
  connectTo,
  openEditor,
  seedDraft,
} from './testing/draft-spec-kit';

/** Smoke path of the collaborative editor over real WebSockets; the per-rule scenarios live in collab-rooms / drafts-publish. */
describe('Collaborative listing drafts (smoke)', () => {
  let t: CatalogTestApp;
  let w: ShopWorld;
  let store: DocStore;
  const open: YClient[] = [];

  const editor = async (user: ShopWorld['owner'], draftId: string) => {
    const client = await openEditor(t, user, w.shop.id, draftId);
    open.push(client);
    return client;
  };

  beforeAll(async () => {
    t = await createCatalogApp({
      extraImports: [DraftsModule, CollabModule, DraftsProjectorModule],
    });
    store = t.app.get<DocStore>(DOC_STORE);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
    await announceRing(t.app);
  });
  afterEach(() => open.splice(0).forEach((c) => c.close()));

  it('S06 AS-14: two editors converge and the persisted state (snapshot + tail) equals the live doc', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    const a = await editor(w.staff, draft.id);
    const b = await editor(w.admin, draft.id);
    await a.whenSynced();
    await b.whenSynced();

    a.doc.getText('title').insert(0, 'iPhone 17 Pro');
    b.doc.getText('title').insert(0, 'NEW: ');
    a.doc.getMap('fields').set('priceMinor', 129_900);

    await waitFor(
      async () =>
        a.title() === b.title() &&
        a.title().length === 'iPhone 17 Pro'.length + 'NEW: '.length &&
        b.doc.getMap('fields').get('priceMinor') === 129_900,
      { description: 'convergence' },
    );
    const persisted = await waitFor(async () => {
      const { doc } = await store.load(w.shop.id, draft.id);
      return doc.getText('title').toString() === a.title() && doc;
    });
    expect(readListing(persisted as Y.Doc)).toMatchObject({
      priceMinor: 129_900,
    });
  });

  it('S06 AS-22: a viewer receives edits but its own writes are dropped server-side', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    const writer = await editor(w.staff, draft.id);
    const reader = await editor(w.viewer, draft.id);
    await writer.whenSynced();
    await reader.whenSynced();

    writer.doc.getText('title').insert(0, 'Official title');
    await waitFor(async () => reader.title() === 'Official title');

    reader.doc.getText('title').insert(0, 'HACKED ');
    await waitFor(async () => reader.denied.length >= 1);
    expect(reader.denied[0]).toBe('read_only');
    expect(writer.title()).toBe('Official title');
    await waitFor(async () => {
      const { doc } = await store.load(w.shop.id, draft.id);
      return doc.getText('title').toString() === 'Official title';
    });
    expect(reader.closed).toBeNull();
  });

  it('S06 AS-13: a viewer is handed a read-only ticket, a ticket for another draft and a missing ticket are refused at the handshake with 401', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    const other = await seedDraft(t.app, w.shop.id, w.owner.id);
    const asViewer = await connectTo(t, w.viewer, w.shop.id, draft.id);
    const asOwner = await connectTo(t, w.owner, w.shop.id, draft.id);
    expect(asViewer.canWrite).toBe(false);
    expect(asOwner.canWrite).toBe(true);
    await t
      .as(w.outsider)
      .post(`/api/shops/${w.shop.id}/drafts/${draft.id}/connect`)
      .expect(404);

    const forged = new YClient(
      `${asOwner.url}?ticket=${asOwner.ticket}`.replace(draft.id, other.id),
    );
    const missing = new YClient(asViewer.url);
    open.push(forged, missing);
    await waitFor(
      async () => forged.refused !== null && missing.refused !== null,
    );
    expect(forged.refused).toBe(401);
    expect(missing.refused).toBe(401);
  });

  it('S06 AS-28: publishing turns the edited document into a product and freezes a published version', async () => {
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    const editor = await openEditor(t, w.staff, w.shop.id, draft.id);
    open.push(editor);
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

    const res = await t
      .as(w.staff)
      .post(`/api/shops/${w.shop.id}/drafts/${draft.id}/publish`)
      .set('Idempotency-Key', 'smoke-key-28')
      .send({})
      .expect(200);
    const product = await productRow<Record<string, unknown>>(
      t.app,
      res.body.productId,
    );
    expect(product).toMatchObject({
      shopId: w.shop.id,
      title: 'AirPods Pro 3',
      category: 'audio',
    });
    expect(Number(product!.priceMinor)).toBe(24_900);
    expect(String(product!.description)).toContain('Adaptive audio.');
    expect(res.body.versionId).toBeTruthy();
    expect(res.body.productVersion).toBe(1);
  });
});
