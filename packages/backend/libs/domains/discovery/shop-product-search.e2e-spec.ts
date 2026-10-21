import { randomUUID } from 'node:crypto';
import { shopProductSearchResponseSchema } from '@marketplace-sandbox/contracts';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { createSearchApp, type SearchTestApp } from './testing/search-app';
import {
  deliver,
  newId,
  productDeleted,
  productEvent,
  shopDeleted,
  snapshot,
} from './testing/search-events';
import { seedProducts } from './testing/search-fixtures';

describe('Shop product search', () => {
  let t: SearchTestApp;
  let owner: Awaited<ReturnType<SearchTestApp['newUser']>>;
  let shop: Awaited<ReturnType<typeof createShop>>;

  beforeAll(async () => {
    t = await createSearchApp({ redisProxy: true });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetSearch();
    owner = await t.newUser();
    shop = await createShop(t.app, owner);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const route = (shopId: string, query: Record<string, string | number>) =>
    t.as(owner).get(`/api/shops/${shopId}/products/search`).query(query);
  const ok = async (query: Record<string, string | number>, shopId = shop.id) =>
    shopProductSearchResponseSchema.parse(
      (await route(shopId, query).expect(200)).body,
    );
  const tableCount = async () =>
    Number(
      (
        await t.rows<{ n: string }>(
          `SELECT count(*) AS n FROM "SearchShopProduct"`,
        )
      )[0].n,
    );

  describe('reading (AS-61 to AS-63)', () => {
    it('S32 AS-61: a member lists matching products best rank first, archived ones with their status, and can filter by status', async () => {
      const [active, archived] = await seedProducts(t, shop.id, [
        { title: 'iPhone 17 Pro Case', priceMinor: 1_999, quantity: 7 },
        { title: 'iPhone 16 Case', status: 'ARCHIVED' },
        { title: 'USB Cable' },
      ]);

      const body = await ok({ q: 'iphone case' });

      expect(body.items.map((i) => i.id).sort()).toEqual(
        [active, archived].sort(),
      );
      expect(body.items.find((i) => i.id === archived)?.status).toBe(
        'ARCHIVED',
      );
      expect(body.items.find((i) => i.id === active)).toMatchObject({
        title: 'iPhone 17 Pro Case',
        priceMinor: 1_999,
        currency: 'USD',
        quantity: 7,
        status: 'ACTIVE',
      });
      expect(body.items[0].rank).toBeGreaterThanOrEqual(body.items[1].rank);
      expect(body.nextCursor).toBeNull();
      expect(
        (await ok({ q: 'iphone case', status: 'ACTIVE' })).items.map(
          (i) => i.id,
        ),
      ).toEqual([active]);
      expect(
        (await ok({ q: 'iphone case', status: 'ARCHIVED' })).items.map(
          (i) => i.id,
        ),
      ).toEqual([archived]);
    });

    it('S32 AS-62: a typo is found by the trigram fallback, garbage finds nothing, words beyond eight are ignored by the fallback', async () => {
      const [id] = await seedProducts(t, shop.id, [
        { title: 'iPhone 17 Pro Case' },
        { title: 'USB Cable' },
      ]);
      expect((await ok({ q: 'iphnoe cse' })).items.map((i) => i.id)).toEqual([
        id,
      ]);
      expect((await ok({ q: 'zz' })).items).toEqual([]);
      // eight good words, then thirty that would pull the average below the threshold if they counted
      const long =
        `iphnoe 17 pro cse iphone 17 pro case ${'z '.repeat(30)}`.trim();
      expect(long.length).toBeLessThanOrEqual(100);
      expect((await ok({ q: long })).items.map((i) => i.id)).toEqual([id]);
    });

    it("S32 AS-63: another shop's member gets the unknown-shop 404; only the shop's own products ever appear", async () => {
      const other = await t.newUser();
      const otherShop = await createShop(t.app, other);
      const [mine] = await seedProducts(t, shop.id, [
        { title: 'iPhone 17 Pro Case' },
      ]);
      const [theirs] = await seedProducts(t, otherShop.id, [
        { title: 'iPhone 17 Pro Case' },
      ]);

      expect((await ok({ q: 'iphone' })).items.map((i) => i.id)).toEqual([
        mine,
      ]);
      await route(otherShop.id, { q: 'iphone' }).expect(404); // the owner is no member of the other shop

      const asOther = await t
        .as(other)
        .get(`/api/shops/${shop.id}/products/search`)
        .query({ q: 'iphone' });
      const unknown = await t
        .as(other)
        .get(`/api/shops/${randomUUID()}/products/search`)
        .query({ q: 'iphone' });
      expect(asOther.status).toBe(404);
      expect(unknown.status).toBe(404);
      const shape = (b: Record<string, unknown>) => ({
        status: b.status,
        code: b.code,
        title: b.title,
        detail: b.detail,
      });
      expect(shape(asOther.body)).toEqual(shape(unknown.body));
      expect(JSON.stringify(asOther.body)).not.toContain(theirs);
    });
  });

  describe('access (AS-64)', () => {
    it('S32 AS-64: 401 without credentials, 200 for a viewer, 403 shop_suspended, 409 shop_offboarding, 404 for a deleted shop', async () => {
      await t
        .http()
        .get(`/api/shops/${shop.id}/products/search`)
        .query({ q: 'x' })
        .expect(401);

      const viewer = await t.newUser();
      await addMember(t.app, shop.id, viewer.id, 'VIEWER');
      await t
        .as(viewer)
        .get(`/api/shops/${shop.id}/products/search`)
        .query({ q: 'x' })
        .expect(200);

      for (const [status, code, http] of [
        ['SUSPENDED', 'shop_suspended', 403],
        ['DELETING', 'shop_offboarding', 409],
        ['DELETED', undefined, 404],
      ] as const) {
        const closed = await createShop(t.app, owner, { status });
        const res = await route(closed.id, { q: 'x' });
        expect(res.status).toBe(http);
        if (code) expect(res.body.code).toBe(code);
      }
    });
  });

  describe('input and paging (AS-65, AS-66)', () => {
    it.each([
      ['q missing', {}],
      ['q empty', { q: '' }],
      ['q blank', { q: '   ' }],
      ['q too long', { q: 'a'.repeat(101) }],
      ['limit zero', { q: 'x', limit: 0 }],
      ['limit above 50', { q: 'x', limit: 51 }],
      ['limit not a number', { q: 'x', limit: 'ten' }],
      ['status unknown', { q: 'x', status: 'DELETED' }],
      ['unknown parameter', { q: 'x', from: 10 }],
    ] as [string, Record<string, string | number>][])(
      'S32 AS-65: %s answers 400 validation_failed',
      async (_name, query) => {
        const res = await route(shop.id, query).expect(400);
        expect(res.body.code).toBe('validation_failed');
      },
    );

    it("S32 AS-65: a malformed shop id is the guard's 404 (S03), and a cursor that was altered, or came from another shop or query, answers 422 invalid_cursor", async () => {
      await route('not-a-uuid', { q: 'x' }).expect(404);

      await seedProducts(
        t,
        shop.id,
        Array.from({ length: 6 }, (_, i) => ({ title: `Cable ${i}` })),
      );
      const first = await ok({ q: 'cable', limit: 2 });
      expect(first.nextCursor).not.toBeNull();
      const cursor = first.nextCursor!;
      await route(shop.id, { q: 'cable', limit: 2, cursor }).expect(200);
      await route(shop.id, {
        q: 'cable',
        limit: 2,
        cursor: `${cursor}x`,
      }).expect(422);
      await route(shop.id, { q: 'plug', limit: 2, cursor }).expect(422);
      await route(shop.id, {
        q: 'cable',
        status: 'ACTIVE',
        limit: 2,
        cursor,
      }).expect(422);
      const second = await createShop(t.app, owner);
      const res = await route(second.id, {
        q: 'cable',
        limit: 2,
        cursor,
      }).expect(422);
      expect(res.body.code).toBe('invalid_cursor');
    });

    it('S32 AS-66: 60 matches page as 25, 25, 10 without duplicate or gap, equal ranks ordered by id', async () => {
      const ids = await seedProducts(
        t,
        shop.id,
        Array.from({ length: 60 }, (_, i) => ({ title: `Cable ${i}` })),
      );
      const pages: Awaited<ReturnType<typeof ok>>[] = [];
      let cursor: string | undefined;
      do {
        const page = await ok({
          q: 'cable',
          limit: 25,
          ...(cursor && { cursor }),
        });
        pages.push(page);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(pages.map((p) => p.items.length)).toEqual([25, 25, 10]);
      expect(pages.at(-1)!.nextCursor).toBeNull();
      const all = pages.flatMap((p) => p.items);
      expect(new Set(all.map((i) => i.id)).size).toBe(60);
      expect(all.map((i) => i.id).sort()).toEqual([...ids].sort());
      for (let i = 1; i < all.length; i++) {
        expect(all[i - 1].rank).toBeGreaterThanOrEqual(all[i].rank);
        if (all[i - 1].rank === all[i].rank)
          expect(all[i - 1].id < all[i].id).toBe(true);
      }
    });
  });

  describe('lifecycle, hostile input and limits (AS-67 to AS-69)', () => {
    it('S32 AS-67: create, rename, archive, restore and delete are reflected at once; a sandbox shop searches its own products only; a deleted shop leaves nothing', async () => {
      const productId = newId();
      const send = (
        kind: 'created' | 'updated' | 'archived' | 'restored',
        version: number,
        title: string,
        status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
      ) =>
        deliver(t.app).products(
          productEvent(
            kind,
            snapshot({
              productId,
              shopId: shop.id,
              title,
              status,
              productVersion: version,
              changedFields: kind === 'updated' ? ['title'] : [],
            }),
            t.clock.now(),
          ),
        );

      await send('created', 1, 'Blue Mug');
      expect((await ok({ q: 'mug' })).items.map((i) => i.title)).toEqual([
        'Blue Mug',
      ]);
      await send('updated', 2, 'Red Mug');
      expect((await ok({ q: 'red' })).items).toHaveLength(1);
      expect((await ok({ q: 'blue' })).items).toHaveLength(0);
      await send('archived', 3, 'Red Mug', 'ARCHIVED');
      expect((await ok({ q: 'red' })).items[0].status).toBe('ARCHIVED');
      await send('restored', 4, 'Red Mug');
      expect((await ok({ q: 'red' })).items[0].status).toBe('ACTIVE');
      await deliver(t.app).products(
        productDeleted(productId, shop.id, 5, t.clock.now()),
      );
      expect((await ok({ q: 'red' })).items).toEqual([]);

      const sandbox = await createShop(t.app, owner, { sandboxOf: shop.id });
      const [inSandbox] = await seedProducts(t, sandbox.id, [
        { title: 'Sandbox Lamp', isSandbox: true },
      ]);
      expect(
        (await ok({ q: 'lamp' }, sandbox.id)).items.map((i) => i.id),
      ).toEqual([inSandbox]);
      const publicRes = await t
        .http()
        .get('/api/products/search')
        .query({ q: 'lamp' })
        .expect(200);
      expect(publicRes.body.items).toEqual([]);

      const doomed = await createShop(t.app, owner);
      await seedProducts(t, doomed.id, [{ title: 'Doomed Vase' }]);
      expect(await tableCount()).toBeGreaterThan(0);
      await deliver(t.app).shops(shopDeleted(doomed.id, 2, t.clock.now()));
      expect(
        await t.rows(`SELECT 1 FROM "SearchShopProduct" WHERE "shopId" = $1`, [
          doomed.id,
        ]),
      ).toEqual([]);
      await t.sequelize.query(
        `UPDATE "Shop" SET "status" = 'DELETED' WHERE "id" = $1`,
        {
          bind: [doomed.id],
        },
      );
      const fresh = await t.newUser();
      await addMember(t.app, doomed.id, fresh.id, 'OWNER', 'owner');
      await t
        .as(fresh)
        .get(`/api/shops/${doomed.id}/products/search`)
        .query({ q: 'vase' })
        .expect(404);
    });

    it('S32 AS-68: hostile text is matched literally, no database error, the table is intact', async () => {
      await seedProducts(t, shop.id, [{ title: 'Plain Mug' }]);
      const before = await tableCount();
      const hostile = [
        "'; DROP TABLE x; --",
        'a & b | !c',
        '"quoted',
        '\\',
        '{a,b}',
        `it's "a" b\\ c' d" e\\ f' g"`,
        `x\\'; DELETE FROM "SearchShopProduct"; -- y" z \\ w' v`,
        '%_ ::text[] $1 ) ( ',
      ];
      for (const q of hostile) {
        const res = await route(shop.id, { q });
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.items)).toBe(true);
      }
      expect(await tableCount()).toBe(before);
    });

    it('S32 AS-69: a member past 120 calls a minute gets 429 with Retry-After; another member or shop is unaffected; with the limiter store down it still serves', async () => {
      const other = await t.newUser();
      await addMember(t.app, shop.id, other.id, 'STAFF');
      const second = await createShop(t.app, owner);

      let limited:
        { status: number; headers: Record<string, string> } | undefined;
      for (let i = 0; i < 125 && !limited; i++) {
        const res = await route(shop.id, { q: 'x' });
        if (res.status === 429) limited = res;
      }
      expect(limited?.status).toBe(429);
      expect(limited?.headers['retry-after']).toBeDefined();

      await t
        .as(other)
        .get(`/api/shops/${shop.id}/products/search`)
        .query({ q: 'x' })
        .expect(200);
      await route(second.id, { q: 'x' }).expect(200);

      t.redisProxy!.mode = 'refuse';
      t.redisProxy!.sever();
      await t
        .as(other)
        .get(`/api/shops/${shop.id}/products/search`)
        .query({ q: 'x' })
        .expect(200);
    });
  });
});
