import { randomUUID } from 'node:crypto';
import { productGallerySchema } from '@marketplace-sandbox/contracts';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { createMediaApp, type MediaTestApp } from './testing/media-app';

/**
 * W02 B-1: the anonymous, public gallery read of a product (`GET /api/products/:productId/gallery`). These four
 * scenarios came with the route from W02 and survive S29's rewrite (L-017) with their original expectations; the member
 * and write sides of the gallery are in `media-gallery.e2e-spec.ts`. Visibility now comes from S05 and S03 (R1).
 */
describe('Media: public product gallery (e2e)', () => {
  let t: MediaTestApp;

  beforeAll(async () => {
    t = await createMediaApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const gallery = (id: string) => t.http().get(`/api/products/${id}/gallery`);

  async function world(shopStatus?: 'SUSPENDED') {
    const owner = await t.newUser();
    const shop = await createShop(
      t.app,
      owner,
      shopStatus ? { status: shopStatus } : {},
    );
    return { owner, shop };
  }

  /** A photo of `status` linked to the product at `position` (the link table is media's own). */
  async function attach(
    productId: string,
    shopId: string,
    uploaderId: string,
    position: number,
    status: 'READY' | 'PROCESSING' | 'REJECTED' = 'READY',
  ) {
    const created =
      status === 'READY'
        ? await t.readyPhoto(shopId, uploaderId)
        : await t.photo({
            shopId,
            uploaderId,
            status,
            rejectCode: status === 'REJECTED' ? 'not_an_image' : null,
          });
    await t.sql(
      `INSERT INTO "ProductMedia" ("productId","mediaId",position) VALUES (:productId,:id,:position)`,
      {
        productId,
        id: created.id,
        position,
      },
    );
    return created.id;
  }

  it('S29 AS-38 (W02 B-1): anonymous caller gets READY media ordered by position, parsed by the contract schema', async () => {
    const { owner, shop } = await world();
    const product = await t.product(shop.id);
    const second = await attach(product.id, shop.id, owner.id, 1);
    const first = await attach(product.id, shop.id, owner.id, 0);

    const res = await gallery(product.id).expect(200);
    expect(res.headers['content-type']).toMatch(/json/);
    const body = productGallerySchema.parse(res.body);
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.mediaId)).toEqual([first, second]);
    expect(body.items.map((i) => i.position)).toEqual([0, 1]);
    expect(body.items[0].urls.thumb).toContain('/media/derived/');
    expect(body.items[0]).toMatchObject({ width: 1600, height: 1200 });
    expect(res.headers['cache-control'] ?? '').not.toMatch(/max-age=15/);
  });

  it('S29 AS-38 (W02 B-1): only READY media is listed; a product without media answers an empty list', async () => {
    const { owner, shop } = await world();
    const product = await t.product(shop.id);
    const ready = await attach(product.id, shop.id, owner.id, 0);
    await attach(product.id, shop.id, owner.id, 1, 'PROCESSING');
    await attach(product.id, shop.id, owner.id, 2, 'REJECTED');
    const res = await gallery(product.id).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items.map((i: { mediaId: string }) => i.mediaId)).toEqual([
      ready,
    ]);
    const links = await t.sql<{ n: string }>(
      `SELECT count(*) AS n FROM "ProductMedia" WHERE "productId" = :id`,
      { id: product.id },
    );
    expect(Number(links[0].n)).toBe(3); // the unfinished photos stay linked; they are only not shown

    const bare = await t.product(shop.id);
    const empty = await gallery(bare.id).expect(200);
    expect(empty.body).toEqual({ items: [] });
  });

  it('S29 AS-38 (W02 B-1): unknown, archived, sandbox and suspended-shop products answer the identical 404', async () => {
    const { owner, shop } = await world();
    const archived = await t.product(shop.id, { status: 'ARCHIVED' });
    const sandbox = await t.product(shop.id, { isSandbox: true });
    const closed = await world('SUSPENDED');
    const inClosed = await t.product(closed.shop.id);
    for (const p of [archived, sandbox])
      await attach(p.id, shop.id, owner.id, 0);
    await attach(inClosed.id, closed.shop.id, closed.owner.id, 0);

    const baseline = await gallery(randomUUID()).expect(404);
    expect(baseline.body.code).toBe('product_not_found');
    const strip = ({
      requestId,
      instance,
      traceId,
      ...rest
    }: Record<string, unknown>) => {
      void requestId;
      void instance;
      void traceId;
      return rest;
    };
    for (const hidden of [archived, sandbox, inClosed]) {
      const res = await gallery(hidden.id).expect(404);
      expect(res.status).toBe(404);
      expect(strip(res.body)).toEqual(strip(baseline.body));
    }
  });

  it('S29 AS-38 (W02 B-1): a signed-in caller gets the same public answer as an anonymous one', async () => {
    const { owner, shop } = await world();
    const product = await t.product(shop.id);
    const photo = await attach(product.id, shop.id, owner.id, 0);
    const anonymous = await gallery(product.id).expect(200);
    const signedIn = await t
      .as(owner)
      .get(`/api/products/${product.id}/gallery`)
      .expect(200);
    expect(signedIn.body).toEqual(anonymous.body);
    expect(signedIn.body.items[0].mediaId).toBe(photo);
  });

  it('S29 AS-38 (W02 B-1): a malformed product id is 400', async () => {
    const res = await gallery('not-a-uuid').expect(400);
    expect(res.body.code).toBe('validation_failed');
  });
});
