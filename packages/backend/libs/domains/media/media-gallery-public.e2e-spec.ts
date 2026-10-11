import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { productGallerySchema } from '@marketplace-sandbox/contracts';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import { MediaModule } from './media.module';

/** W02 B-1: the anonymous, public gallery read of a product (`GET /api/products/:productId/gallery`). */
describe('Media: public product gallery (e2e)', () => {
  let t: CatalogTestApp;
  let db: Sequelize;

  beforeAll(async () => {
    t = await createCatalogApp({ extraImports: [MediaModule] });
    db = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const gallery = (id: string) => t.http().get(`/api/products/${id}/gallery`);

  async function world(shopStatus?: string) {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner, {});
    if (shopStatus)
      await db.query(
        `INSERT INTO "ProductShopState" ("shopId","status","shopVersion","updatedAt") VALUES (:shopId,:status,2,now())
         ON CONFLICT ("shopId") DO UPDATE SET "status" = :status`,
        { replacements: { shopId: shop.id, status: shopStatus } },
      );
    return { owner, shop };
  }

  async function attach(
    productId: string,
    shopId: string,
    uploaderId: string,
    position: number,
    status = 'READY',
  ) {
    const id = randomUUID();
    const variants = Object.fromEntries(
      (['thumb', 'feed', 'full'] as const).map((name) => [
        name,
        { key: `media/v/${id}/${name}.webp`, width: 100, height: 80 },
      ]),
    );
    await db.query(
      `INSERT INTO "Media" ("id","shopId","uploaderId",purpose,status,"originalKey",variants,width,height)
       VALUES (:id,:shopId,:uploaderId,'product',:status,:key,:variants::jsonb,1600,1200)`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          id,
          shopId,
          uploaderId,
          status,
          key: `media/originals/${id}`,
          variants: status === 'READY' ? JSON.stringify(variants) : null,
        },
      },
    );
    await db.query(
      `INSERT INTO "ProductMedia" ("productId","mediaId",position) VALUES (:productId,:id,:position)`,
      { replacements: { productId, id, position } },
    );
    return id;
  }

  it('W02 B-1: anonymous caller gets READY media ordered by position, parsed by the contract schema', async () => {
    const { owner, shop } = await world();
    const product = await createProduct(t.app, shop);
    const second = await attach(product.id, shop.id, owner.id, 1);
    const first = await attach(product.id, shop.id, owner.id, 0);

    const res = await gallery(product.id).expect(200);
    const body = productGallerySchema.parse(res.body);
    expect(body.items.map((i) => i.mediaId)).toEqual([first, second]);
    expect(body.items.map((i) => i.position)).toEqual([0, 1]);
    expect(body.items[0].urls.thumb).toContain(`media/v/${first}/thumb.webp`);
    expect(body.items[0]).toMatchObject({ width: 1600, height: 1200 });
    expect(res.headers['cache-control'] ?? '').not.toMatch(/max-age=15/);
  });

  it('W02 B-1: only READY media is listed; a product without media answers an empty list', async () => {
    const { owner, shop } = await world();
    const product = await createProduct(t.app, shop);
    const ready = await attach(product.id, shop.id, owner.id, 0);
    await attach(product.id, shop.id, owner.id, 1, 'PROCESSING');
    await attach(product.id, shop.id, owner.id, 2, 'REJECTED');
    const res = await gallery(product.id).expect(200);
    expect(res.body.items.map((i: { mediaId: string }) => i.mediaId)).toEqual([
      ready,
    ]);

    const bare = await createProduct(t.app, shop);
    const empty = await gallery(bare.id).expect(200);
    expect(empty.body).toEqual({ items: [] });
  });

  it('W02 B-1: unknown, archived, sandbox and suspended-shop products answer the identical 404', async () => {
    const { owner, shop } = await world();
    const archived = await createProduct(t.app, shop, { status: 'ARCHIVED' });
    const sandbox = await createProduct(t.app, shop, { isSandbox: true });
    const closed = await world('SUSPENDED');
    const inClosed = await createProduct(t.app, closed.shop);
    for (const p of [archived, sandbox])
      await attach(p.id, shop.id, owner.id, 0);
    await attach(inClosed.id, closed.shop.id, closed.owner.id, 0);

    const baseline = await gallery(randomUUID()).expect(404);
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
      expect(strip(res.body)).toEqual(strip(baseline.body));
    }
  });

  it('W02 B-1: a malformed product id is 400', async () => {
    await gallery('not-a-uuid').expect(400);
  });
});
