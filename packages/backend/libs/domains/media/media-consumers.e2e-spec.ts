import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { validateDeclaration } from '@app/infrastructure/projections/consumer-declaration';
import { ProductDeleted } from '@app/domains/catalog';
import { ShopDeleted } from '@app/domains/tenancy';
import { generateTestingModule } from '@app/test/utils/global-modules';
import {
  MediaProductDeletedProjector,
  MediaShopDeletedProjector,
} from './infra/media-consumers';
import { MediaProjectorModule } from './media-projector.module';
import {
  createMediaApp,
  type MediaTestApp,
  type MediaWorld,
} from './testing/media-app';

describe('Media event consumers', () => {
  let t: MediaTestApp;
  let w: MediaWorld;
  let productConsumer: MediaProductDeletedProjector;
  let shopConsumer: MediaShopDeletedProjector;

  beforeAll(async () => {
    t = await createMediaApp({ extraImports: [MediaProjectorModule] });
    productConsumer = t.app.get(MediaProductDeletedProjector);
    shopConsumer = t.app.get(MediaShopDeletedProjector);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
  });

  const productDeleted = (
    productId: string,
    shopId: string,
    version = 2,
  ): EventEnvelope =>
    ProductDeleted.create(productId, version, {
      productId,
      shopId,
      productVersion: version,
    }) as EventEnvelope;
  const shopDeleted = (shopId: string): EventEnvelope =>
    ShopDeleted.create(shopId, 3, { shopId, shopVersion: 3 }) as EventEnvelope;
  const galleryRows = (productId: string) =>
    t
      .sql<{ n: string }>(
        `SELECT (SELECT count(*) FROM "ProductMedia" WHERE "productId" = :productId)
            + (SELECT count(*) FROM "ProductGallery" WHERE "productId" = :productId) AS n`,
        { productId },
      )
      .then((rows) => Number(rows[0].n));
  const withGallery = async (shopId: string, uploader: string) => {
    const product = await t.product(shopId);
    const photos = await Promise.all([
      t.readyPhoto(shopId, uploader),
      t.readyPhoto(shopId, uploader),
    ]);
    await t.sql(
      `INSERT INTO "ProductGallery" ("productId","shopId","version") VALUES (:p,:s,1)`,
      { p: product.id, s: shopId },
    );
    await t.sql(
      `INSERT INTO "ProductMedia" ("productId","mediaId","position") VALUES (:p,:a,0),(:p,:b,1)`,
      {
        p: product.id,
        a: photos[0].id,
        b: photos[1].id,
      },
    );
    return { product, photos };
  };

  it('S29 declaration: both consumers are valid S53 declarations with natural idempotency', () => {
    for (const consumer of [productConsumer, shopConsumer]) {
      expect(() => validateDeclaration(consumer)).not.toThrow();
      expect(consumer.idempotency).toBe('natural');
    }
    expect(MediaProjectorModule.projectors).toEqual([
      MediaProductDeletedProjector,
      MediaShopDeletedProjector,
    ]);
    expect(productConsumer.topics).toEqual(['products.events']);
    expect(shopConsumer.topics).toEqual(['tenancy.events']);
  });

  it('S29 AS-39: a deleted product loses its gallery; the photos stay READY and unattached; a second delivery changes nothing', async () => {
    const { product, photos } = await withGallery(w.shop.id, w.staff.id);
    const other = await withGallery(w.shop.id, w.staff.id);
    await productConsumer.project([productDeleted(product.id, w.shop.id)]);
    expect(await galleryRows(product.id)).toBe(0);
    for (const photo of photos)
      expect((await t.row(photo.id))!.status).toBe('READY');
    expect(await galleryRows(other.product.id)).toBe(3); // another product is untouched
    await productConsumer.project([productDeleted(product.id, w.shop.id)]);
    expect(await galleryRows(product.id)).toBe(0);
    await productConsumer.project([productDeleted(randomUUID(), w.shop.id)]); // no gallery: a no-op
  });

  it('S29 AS-39: invalid events are poison with no side effect, and the rest of the batch is applied', async () => {
    const a = await withGallery(w.shop.id, w.staff.id);
    const b = await withGallery(w.shop.id, w.staff.id);
    const c = await withGallery(w.shop.id, w.staff.id);
    const valid = productDeleted(a.product.id, w.shop.id);
    const missing = {
      ...productDeleted(c.product.id, w.shop.id),
      payload: { shopId: w.shop.id, productVersion: 2 },
    };
    const notUuid = {
      ...productDeleted(c.product.id, w.shop.id),
      payload: { productId: 'nope', shopId: w.shop.id, productVersion: 2 },
    };
    const unknownType = {
      ...productDeleted(c.product.id, w.shop.id),
      type: 'catalog.something_else',
    };
    const newerVersion = {
      ...productDeleted(c.product.id, w.shop.id),
      version: 2,
    };
    const last = productDeleted(b.product.id, w.shop.id);
    await expect(
      productConsumer.project([
        valid,
        missing,
        notUuid,
        unknownType,
        newerVersion,
        last,
      ]),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(await galleryRows(a.product.id)).toBe(0);
    expect(await galleryRows(b.product.id)).toBe(0);
    expect(await galleryRows(c.product.id)).toBe(3); // the poison events touched nothing
  });

  it('S29 AS-40: a deleted shop loses its photos and galleries; one media.deleted per photo; twice is one effect', async () => {
    const { product } = await withGallery(w.shop.id, w.staff.id);
    const statuses = [
      'PENDING_UPLOAD',
      'UPLOADED',
      'PROCESSING',
      'REJECTED',
      'EXPIRED',
      'DELETED',
    ] as const;
    const others = await Promise.all(
      statuses.map((status) =>
        t.photo({
          shopId: w.shop.id,
          uploaderId: w.staff.id,
          status,
          rejectCode: status === 'REJECTED' ? 'not_an_image' : null,
        }),
      ),
    );
    const survivors = await withGallery(w.otherShop.id, w.otherOwner.id);
    const review = await t.photo({
      shopId: null,
      uploaderId: w.buyer.id,
      status: 'READY',
      purpose: 'review',
    });

    await shopConsumer.project([shopDeleted(w.shop.id)]);

    const photos = await t.sql<{ id: string; status: string }>(
      `SELECT "id","status" FROM "Media" WHERE "shopId" = :shop`,
      { shop: w.shop.id },
    );
    expect(photos).toHaveLength(8); // 2 ready + 6 others
    expect(photos.every((p) => p.status === 'DELETED')).toBe(true);
    const deleted = await t.outbox('media.deleted');
    expect(deleted).toHaveLength(7); // the one already DELETED publishes nothing
    for (const e of deleted)
      expect(e.payload).toMatchObject({
        shopId: w.shop.id,
        purpose: 'product',
      });
    expect(
      deleted.map((e) => e.payload.mediaVersion).every((v) => v >= 2),
    ).toBe(true);
    const history = await t.history(others[0].id);
    expect(history.at(-1)).toMatchObject({
      fromStatus: 'PENDING_UPLOAD',
      toStatus: 'DELETED',
      actorType: 'system',
    });
    expect(await galleryRows(product.id)).toBe(0);
    expect(await galleryRows(survivors.product.id)).toBe(3);
    expect((await t.row(survivors.photos[0].id))!.status).toBe('READY');
    expect((await t.row(review.id))!.status).toBe('READY');

    await shopConsumer.project([shopDeleted(w.shop.id)]);
    expect(await t.outbox('media.deleted')).toHaveLength(7);
  });

  it('S29 AS-40: an invalid shop event is poison; a late worker run for a deleted shop photo answers SKIPPED', async () => {
    const inFlight = await t.photo({
      shopId: w.shop.id,
      uploaderId: w.staff.id,
      status: 'UPLOADED',
      uploadedAt: t.clock.now(),
    });
    await t.putOriginal(
      inFlight.originalKey,
      Buffer.from('not needed, the claim fails first'),
    );
    const bad = {
      ...shopDeleted(w.shop.id),
      payload: { shopId: 'nope', shopVersion: 1 },
    };
    await expect(shopConsumer.project([bad])).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect((await t.row(inFlight.id))!.status).toBe('UPLOADED');

    await shopConsumer.project([shopDeleted(w.shop.id)]);
    expect((await t.row(inFlight.id))!.status).toBe('DELETED');
    expect(await t.processor().process(inFlight.originalKey)).toBe('SKIPPED'); // no resurrection
    expect((await t.row(inFlight.id))!.status).toBe('DELETED');
  });

  it('S29 S32 follow-up: the projector module loads on its own (database and clock only, no storage, queue or catalog module)', async () => {
    const imports = Reflect.getMetadata(
      'imports',
      MediaProjectorModule,
    ) as unknown[];
    expect(imports.map((m) => (m as { name: string }).name)).toEqual([
      'ClockModule',
    ]);
    const moduleRef = await generateTestingModule([MediaProjectorModule]);
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(app.get(MediaProductDeletedProjector)).toBeInstanceOf(
      MediaProductDeletedProjector,
    );
    expect(app.get(MediaShopDeletedProjector)).toBeInstanceOf(
      MediaShopDeletedProjector,
    );
    await app.close();
    void Test;
  });
});
