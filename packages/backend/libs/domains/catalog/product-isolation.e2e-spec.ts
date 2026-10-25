import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { productMemberSchema } from '@marketplace-sandbox/contracts';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import {
  createProduct,
  createProducts,
  productRow,
} from '@app/test/utils/catalog-fixtures';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import {
  catalogEventCount,
  createShopWorld,
  stableProblem,
  type ShopWorld,
} from './testing/catalog-spec-kit';
import { encodeProductCursor } from './domain/product-cursor';

const UNKNOWN_SHOP = '00000000-0000-4000-8000-0000000000ee';
const validBody = {
  title: 'Wool coat',
  description: 'Warm',
  brand: 'Nord',
  category: 'coats',
  priceMinor: 12_900,
  quantity: 5,
  tags: ['winter'],
};

/** Seller A against seller B on every product route a seller page uses (QA track 4). */
describe('Product seller isolation', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;
  let a: ShopWorld;
  let b: ShopWorld;

  const base = (shopId: string) => `/api/shops/${shopId}/products`;
  const stored = (id: string) =>
    productRow<{ title: string; status: string; version: number; quantity: number }>(
      t.app,
      id,
    );

  beforeAll(async () => {
    t = await createCatalogApp();
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    a = await createShopWorld(t);
    b = await createShopWorld(t);
  });

  describe('a shop that is not yours (path shop B, token of seller A)', () => {
    const ROUTES = [
      {
        name: 'list',
        call: (u: ShopWorld['owner'], shop: string) =>
          t.as(u).get(base(shop)),
      },
      {
        name: 'create',
        call: (u: ShopWorld['owner'], shop: string) =>
          t.as(u).post(base(shop)).send(validBody),
      },
      {
        name: 'read',
        call: (u: ShopWorld['owner'], shop: string, p: string) =>
          t.as(u).get(`${base(shop)}/${p}`),
      },
      {
        name: 'update',
        call: (u: ShopWorld['owner'], shop: string, p: string) =>
          t.as(u).patch(`${base(shop)}/${p}`).send({ expectedVersion: 1, title: 'Hijacked' }),
      },
      {
        name: 'archive',
        call: (u: ShopWorld['owner'], shop: string, p: string) =>
          t.as(u).post(`${base(shop)}/${p}/archive`).send({ expectedVersion: 1 }),
      },
      {
        name: 'restore',
        call: (u: ShopWorld['owner'], shop: string, p: string) =>
          t.as(u).post(`${base(shop)}/${p}/restore`).send({ expectedVersion: 1 }),
      },
    ] as const;

    it.each(ROUTES)(
      'S05 SC-002: $name on shop B by the owner of shop A is the same 404 as for an unknown shop and changes nothing',
      async (route) => {
        const product = await createProduct(t.app, b.shop, { title: 'B secret' });
        const foreign = await route.call(a.owner, b.shop.id, product.id);
        const unknown = await route.call(a.owner, UNKNOWN_SHOP, product.id);
        expect(foreign.status).toBe(404);
        expect(foreign.body.code).toBe('shop_not_found');
        expect(stableProblem(foreign.body)).toEqual(stableProblem(unknown.body));
        expect(JSON.stringify(foreign.body)).not.toContain('B secret');

        expect(await stored(product.id)).toMatchObject({
          title: 'B secret',
          status: 'ACTIVE',
          version: 1,
        });
        const [{ n }] = await sequelize.query<{ n: string }>(
          `SELECT count(*) AS n FROM "Product" WHERE "shopId" = :s`,
          { type: QueryTypes.SELECT, replacements: { s: b.shop.id } },
        );
        expect(Number(n)).toBe(1);
        expect(await catalogEventCount(t.app)).toBe(0);
      },
    );

    it('S05 SC-002: a member of both shops has the rights of each shop only: owner in A, viewer in B', async () => {
      const both = await t.newUser();
      await addMember(t.app, a.shop.id, both.id, 'OWNER');
      await addMember(t.app, b.shop.id, both.id, 'VIEWER');
      const mineA = await createProduct(t.app, a.shop);
      const mineB = await createProduct(t.app, b.shop, { title: 'B only' });

      await t.as(both).patch(`${base(a.shop.id)}/${mineA.id}`).send({ expectedVersion: 1, title: 'Ok' }).expect(200);
      await t.as(both).get(`${base(b.shop.id)}/${mineB.id}`).expect(200);
      const denied = await t
        .as(both)
        .patch(`${base(b.shop.id)}/${mineB.id}`)
        .send({ expectedVersion: 1, title: 'Hijacked' })
        .expect(403);
      expect(denied.body.code).toBe('permission_denied');
      expect(await stored(mineB.id)).toMatchObject({ title: 'B only', version: 1 });
    });

    it('S05 SC-002: the shop in the X-Shop-Id header must match the path: a header naming shop B on shop A path is refused and changes nothing', async () => {
      const product = await createProduct(t.app, a.shop);
      const mismatch = await t
        .as(a.owner)
        .patch(`${base(a.shop.id)}/${product.id}`)
        .set('X-Shop-Id', b.shop.id)
        .send({ expectedVersion: 1, title: 'Header trick' });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body.code).toBe('shop_mismatch');
      expect(await stored(product.id)).toMatchObject({ title: product.title, version: 1 });

      const own = await t
        .as(a.owner)
        .get(`${base(a.shop.id)}/${product.id}`)
        .set('X-Shop-Id', a.shop.id.toUpperCase());
      expect(own.status).toBe(200);
    });

    it('S05 SC-002: a shopId in a create or update body cannot move a write into shop B', async () => {
      const product = await createProduct(t.app, a.shop);
      for (const send of [
        () => t.as(a.owner).post(base(a.shop.id)).send({ ...validBody, shopId: b.shop.id }),
        () =>
          t
            .as(a.owner)
            .patch(`${base(a.shop.id)}/${product.id}`)
            .send({ expectedVersion: 1, shopId: b.shop.id }),
      ]) {
        const res = await send();
        expect([400, 422]).toContain(res.status);
      }
      const inB = await sequelize.query(`SELECT 1 FROM "Product" WHERE "shopId" = :s`, {
        type: QueryTypes.SELECT,
        replacements: { s: b.shop.id },
      });
      expect(inB).toHaveLength(0);
      expect(await stored(product.id)).toMatchObject({ version: 1 });
    });
  });

  describe('a product id of shop B under the path of shop A', () => {
    it.each([
      ['read', (shop: string, p: string, u: ShopWorld['owner']) => t.as(u).get(`${base(shop)}/${p}`)],
      [
        'update',
        (shop: string, p: string, u: ShopWorld['owner']) =>
          t.as(u).patch(`${base(shop)}/${p}`).send({ expectedVersion: 1, title: 'Hijacked' }),
      ],
      [
        'archive',
        (shop: string, p: string, u: ShopWorld['owner']) =>
          t.as(u).post(`${base(shop)}/${p}/archive`).send({ expectedVersion: 1 }),
      ],
      [
        'restore',
        (shop: string, p: string, u: ShopWorld['owner']) =>
          t.as(u).post(`${base(shop)}/${p}/restore`).send({ expectedVersion: 1 }),
      ],
    ] as const)(
      'S05 SC-002: %s with a foreign product id is the same 404 product_not_found as a random id; the product of shop B is untouched',
      async (_name, call) => {
        const theirs = await createProduct(t.app, b.shop, {
          title: 'B secret',
          status: _name === 'restore' ? 'ARCHIVED' : 'ACTIVE',
        });
        const foreign = await call(a.shop.id, theirs.id, a.owner);
        const random = await call(a.shop.id, randomUUID(), a.owner);
        expect(foreign.status).toBe(404);
        expect(foreign.body.code).toBe('product_not_found');
        expect(stableProblem(foreign.body)).toEqual(stableProblem(random.body));
        expect(JSON.stringify(foreign.body)).not.toContain('B secret');
        expect(await stored(theirs.id)).toMatchObject({
          title: 'B secret',
          status: _name === 'restore' ? 'ARCHIVED' : 'ACTIVE',
          version: 1,
        });
        expect(await catalogEventCount(t.app)).toBe(0);
      },
    );

    it('S05 SC-002: ids in other spellings (upper case, malformed, path tricks) never reach shop B data', async () => {
      const theirs = await createProduct(t.app, b.shop, { title: 'B secret' });
      const urls = [
        `${base(a.shop.id)}/${theirs.id.toUpperCase()}`,
        `${base(a.shop.id)}/${theirs.id}%20`,
        `${base(a.shop.id)}/..%2F..%2F${b.shop.id}%2Fproducts%2F${theirs.id}`,
        `${base(a.shop.id)}/${theirs.id},${theirs.id}`,
      ];
      for (const url of urls) {
        const res = await t.as(a.owner).get(url);
        expect([400, 404]).toContain(res.status);
        expect(JSON.stringify(res.body)).not.toContain('B secret');
      }
    });
  });

  describe('lists and cursors', () => {
    it('S05 SC-002: the list of shop A holds only products of shop A under every filter and page size', async () => {
      await createProducts(t.app, a.shop, 7, { category: 'coats', title: 'A item' });
      await createProducts(t.app, b.shop, 7, { category: 'coats', title: 'B secret' });
      await createProduct(t.app, b.shop, { status: 'ARCHIVED', title: 'B secret archived' });

      for (const query of [
        '',
        '?limit=100',
        '?limit=2',
        '?category=coats',
        '?status=ARCHIVED',
        '?inStock=true',
        '?inStock=false',
      ]) {
        const res = await t.as(a.owner).get(`${base(a.shop.id)}${query}`).expect(200);
        for (const item of res.body.items) {
          productMemberSchema.parse(item);
          expect(item.shopId).toBe(a.shop.id);
        }
        expect(JSON.stringify(res.body)).not.toContain('B secret');
      }
    });

    it('S05 SC-002: walking every page of shop A never meets a product of shop B', async () => {
      await createProducts(t.app, a.shop, 9, { title: 'A item' });
      await createProducts(t.app, b.shop, 9, { title: 'B secret' });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await t
          .as(a.viewer)
          .get(`${base(a.shop.id)}?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
          .expect(200);
        seen.push(...res.body.items.map((p: { id: string; shopId: string }) => p.id));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(9);
      expect(new Set(seen).size).toBe(9);
    });

    it('S05 AS-14: a cursor issued for shop B is 400 invalid_cursor in shop A, whether it came from the first page or the last', async () => {
      await createProducts(t.app, a.shop, 5);
      await createProducts(t.app, b.shop, 5, { title: 'B secret' });
      const theirs = await t.as(b.owner).get(`${base(b.shop.id)}?limit=2`).expect(200);
      expect(theirs.body.nextCursor).toEqual(expect.any(String));
      const res = await t
        .as(a.owner)
        .get(`${base(a.shop.id)}?limit=2&cursor=${theirs.body.nextCursor}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_cursor');
      expect(JSON.stringify(res.body)).not.toContain('B secret');
    });

    it('S05 AS-14: the cursor of shop A does not open shop B for seller A, and it is the shop 404 first, not a cursor error', async () => {
      await createProducts(t.app, a.shop, 5);
      const mine = await t.as(a.owner).get(`${base(a.shop.id)}?limit=2`).expect(200);
      const res = await t
        .as(a.owner)
        .get(`${base(b.shop.id)}?limit=2&cursor=${mine.body.nextCursor}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('shop_not_found');
    });

    it('S05 AS-14: a cursor forged for shop A that points at the position of a product of shop B still shows only shop A', async () => {
      const mine = await createProducts(t.app, a.shop, 4, { title: 'A item' });
      const theirs = await createProduct(t.app, b.shop, {
        title: 'B secret',
        createdAt: new Date(Date.now() - 60_000),
      });
      const forged = encodeProductCursor(
        { createdAt: theirs.createdAt.toISOString(), id: theirs.id },
        { shopId: a.shop.id, status: 'ACTIVE', category: null, inStock: null },
      );
      const res = await t.as(a.owner).get(`${base(a.shop.id)}?cursor=${forged}`);
      expect([200, 400]).toContain(res.status);
      if (res.status === 200) {
        expect(JSON.stringify(res.body)).not.toContain('B secret');
        for (const item of res.body.items) expect(mine.map((m) => m.id)).toContain(item.id);
      }
    });
  });

  describe('roles inside the shop', () => {
    it('S05 AS-04: a viewer reads the list and a product but writes nothing; staff of shop A cannot reach shop B at all', async () => {
      const mine = await createProduct(t.app, a.shop);
      await t.as(a.viewer).get(base(a.shop.id)).expect(200);
      await t.as(a.viewer).get(`${base(a.shop.id)}/${mine.id}`).expect(200);
      await t.as(a.viewer).patch(`${base(a.shop.id)}/${mine.id}`).send({ expectedVersion: 1, title: 'x' }).expect(403);
      await t.as(a.staff).get(base(b.shop.id)).expect(404);
      await t.as(b.outsider).get(base(a.shop.id)).expect(404);
      expect(await stored(mine.id)).toMatchObject({ version: 1 });
    });

    it('S05 AS-04: a member removed from shop A loses the shop at once: list, read and write answer 404 and nothing is created', async () => {
      const mine = await createProduct(t.app, a.shop);
      const leaver = await t.newUser();
      await addMember(t.app, a.shop.id, leaver.id, 'STAFF');
      await t.as(leaver).get(`${base(a.shop.id)}/${mine.id}`).expect(200);
      await t.as(a.owner).delete(`/api/shops/${a.shop.id}/members/${leaver.id}`).expect(204);

      for (const res of [
        await t.as(leaver).get(base(a.shop.id)),
        await t.as(leaver).get(`${base(a.shop.id)}/${mine.id}`),
        await t.as(leaver).post(base(a.shop.id)).send(validBody),
        await t.as(leaver).patch(`${base(a.shop.id)}/${mine.id}`).send({ expectedVersion: 1, title: 'x' }),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('shop_not_found');
      }
      expect(await stored(mine.id)).toMatchObject({ version: 1 });
      expect(
        await sequelize.query(`SELECT 1 FROM "Product" WHERE "shopId" = :s`, {
          type: QueryTypes.SELECT,
          replacements: { s: a.shop.id },
        }),
      ).toHaveLength(1);
    });
  });

  describe('closed shops (S03 FR-013)', () => {
    it.each([
      ['SUSPENDED', 403, 'shop_suspended'],
      ['DELETING', 409, 'shop_offboarding'],
      ['DELETED', 404, 'shop_not_found'],
    ] as const)(
      'S05 AS-05: a %s shop refuses the list and the read to its own members (%i %s) and still hides itself from strangers',
      async (status, http, code) => {
        const closed = await createShopWorld(t, { status });
        const product = await createProduct(t.app, closed.shop);
        for (const user of [closed.owner, closed.staff, closed.viewer]) {
          for (const url of [base(closed.shop.id), `${base(closed.shop.id)}/${product.id}`]) {
            const res = await t.as(user).get(url);
            expect(res.status).toBe(http);
            expect(res.body.code).toBe(code);
          }
        }
        // a stranger learns nothing more: the same 404 as for an unknown shop
        const stranger = await t.as(a.owner).get(base(closed.shop.id));
        expect(stranger.status).toBe(404);
        expect(stranger.body.code).toBe('shop_not_found');
        expect(await stored(product.id)).toMatchObject({ version: 1, status: 'ACTIVE' });
      },
    );

    it('S05 AS-25: a closed or archived product is gone from the public detail and the batch read, and the batch answers null in its place', async () => {
      const closed = await createShopWorld(t, { status: 'SUSPENDED' });
      // the public side learns the shop state from the S03 projection, not from the shop table
      await sequelize.query(
        `INSERT INTO "ProductShopState" ("shopId","status","shopVersion","updatedAt") VALUES (:shopId,'SUSPENDED',2,now())`,
        { replacements: { shopId: closed.shop.id } },
      );
      const hidden = await createProduct(t.app, closed.shop, { title: 'Hidden one' });
      const archived = await createProduct(t.app, a.shop, { status: 'ARCHIVED', title: 'Hidden two' });
      const sandbox = await createProduct(t.app, a.shop, { isSandbox: true, title: 'Hidden three' });
      const visible = await createProduct(t.app, a.shop, { title: 'Visible' });
      for (const p of [hidden, archived, sandbox])
        await t.http().get(`/api/products/${p.id}`).expect(404);

      const batch = await t
        .http()
        .get(`/api/batch/products?ids=${[hidden.id, archived.id, visible.id, sandbox.id].join(',')}`)
        .expect(200);
      expect(batch.body.map((x: { id: string } | null) => x?.id ?? null)).toEqual([
        null,
        null,
        visible.id,
        null,
      ]);
      expect(JSON.stringify(batch.body)).not.toMatch(/Hidden/);
    });
  });

  it('S05 SC-002: the shop-less list, read and write routes do not exist, so no id can be used without a shop', async () => {
    const mine = await createProduct(t.app, a.shop);
    // 404 for a route that is not there, 405 for the public read route that has no write verbs
    const refused = [
      await t.as(a.owner).get('/api/products'),
      await t.as(a.owner).patch(`/api/products/${mine.id}`).send({ expectedVersion: 1, title: 'x' }),
      await t.as(a.owner).post(`/api/products/${mine.id}/archive`).send({ expectedVersion: 1 }),
    ];
    for (const res of refused) expect([400, 404, 405]).toContain(res.status);
    expect(await stored(mine.id)).toMatchObject({ version: 1 });
  });

  it('S05 SC-002: a seller with a shop of their own can write there, but a DELETED shop id is a 404 and receives nothing', async () => {
    const outsiderShop = await createShop(t.app, a.outsider);
    const gone = await createShop(t.app, null, { status: 'DELETED' });
    await t.as(a.outsider).post(base(outsiderShop.id)).send(validBody).expect(201);
    const res = await t.as(a.outsider).post(base(gone.id)).send(validBody);
    expect(res.status).toBe(404);
    expect(
      await sequelize.query(`SELECT 1 FROM "Product" WHERE "shopId" = :s`, {
        type: QueryTypes.SELECT,
        replacements: { s: gone.id },
      }),
    ).toHaveLength(0);
  });
});
