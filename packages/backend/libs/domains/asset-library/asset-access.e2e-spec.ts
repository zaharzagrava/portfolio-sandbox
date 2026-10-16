import { v7 as uuidv7 } from 'uuid';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  createAssetApp,
  type Actor,
  type AssetTestApp,
  type Seller,
} from './testing/asset-client';

const cursor0 = Buffer.from('v1:journal:0').toString('base64url');

interface Fixture {
  s: Seller;
  assetId: string;
  productId: string;
  linkId: string;
  copyId: string;
}

describe('Asset library: authorization and tenant isolation', () => {
  let t: AssetTestApp;
  beforeAll(async () => {
    t = await createAssetApp();
  });
  afterAll(async () => {
    await t.close();
  });

  /** A shop with an asset of two versions, a share link and a product linked to a second asset. */
  async function fixture(): Promise<Fixture> {
    const s = await t.seller();
    const first = await t.save(s, '/a.bin', t.randomBytes(8_000));
    await t.save(s, '/a.bin', t.randomBytes(8_000), { baseVersion: 1 });
    const assetId = first.commit.body.assetId as string;
    const link = await t
      .http()
      .post(`/api/shops/${s.shopId}/assets/${assetId}/share`)
      .set(s.auth)
      .send({ expiresInHours: 5 })
      .expect(201);
    const copy = await t.save(s, '/b.bin', t.randomBytes(4_000));
    const product = await t.product(s);
    return {
      s,
      assetId,
      productId: product.id,
      linkId: link.body.id,
      copyId: copy.commit.body.assetId,
    };
  }

  interface Endpoint {
    name: string;
    kind: 'read' | 'write';
    method: 'get' | 'post' | 'put' | 'delete';
    path: (f: Fixture) => string;
    body?: (f: Fixture) => object;
    ok: number;
  }
  const endpoints: Endpoint[] = [
    {
      name: 'list',
      kind: 'read',
      method: 'get',
      path: (f) => `/shops/${f.s.shopId}/assets`,
      ok: 200,
    },
    {
      name: 'changes',
      kind: 'read',
      method: 'get',
      path: (f) => `/shops/${f.s.shopId}/assets/changes?cursor=${cursor0}`,
      ok: 200,
    },
    {
      name: 'versions',
      kind: 'read',
      method: 'get',
      path: (f) => `/shops/${f.s.shopId}/assets/${f.assetId}/versions`,
      ok: 200,
    },
    {
      name: 'manifest',
      kind: 'read',
      method: 'get',
      path: (f) => `/shops/${f.s.shopId}/assets/${f.assetId}/manifest`,
      ok: 200,
    },
    {
      name: 'digital link read',
      kind: 'read',
      method: 'get',
      path: (f) => `/shops/${f.s.shopId}/products/${f.productId}/digital-asset`,
      ok: 404,
    },
    {
      name: 'prepare',
      kind: 'write',
      method: 'post',
      path: (f) => `/shops/${f.s.shopId}/assets/prepare`,
      body: () => ({ chunks: [{ hash: 'a'.repeat(64), size: 5 }] }),
      ok: 200,
    },
    {
      name: 'delete version',
      kind: 'write',
      method: 'delete',
      path: (f) => `/shops/${f.s.shopId}/assets/${f.assetId}/versions/1`,
      ok: 204,
    },
    {
      name: 'restore',
      kind: 'write',
      method: 'post',
      path: (f) =>
        `/shops/${f.s.shopId}/assets/${f.assetId}/versions/1/restore`,
      body: () => ({ baseVersion: 2 }),
      ok: 201,
    },
    {
      name: 'share create',
      kind: 'write',
      method: 'post',
      path: (f) => `/shops/${f.s.shopId}/assets/${f.assetId}/share`,
      body: () => ({ expiresInHours: 1 }),
      ok: 201,
    },
    {
      name: 'share list',
      kind: 'write',
      method: 'get',
      path: (f) => `/shops/${f.s.shopId}/assets/${f.assetId}/share-links`,
      ok: 200,
    },
    {
      name: 'share revoke',
      kind: 'write',
      method: 'delete',
      path: (f) =>
        `/shops/${f.s.shopId}/assets/${f.assetId}/share-links/${f.linkId}`,
      ok: 204,
    },
    {
      name: 'link product',
      kind: 'write',
      method: 'put',
      path: (f) =>
        `/shops/${f.s.shopId}/products/${f.productId}/digital-asset/${f.copyId}`,
      ok: 204,
    },
    {
      name: 'unlink product',
      kind: 'write',
      method: 'delete',
      path: (f) => `/shops/${f.s.shopId}/products/${f.productId}/digital-asset`,
      ok: 404,
    },
    {
      name: 'delete asset',
      kind: 'write',
      method: 'delete',
      path: (f) => `/shops/${f.s.shopId}/assets/${f.assetId}`,
      ok: 204,
    },
    {
      name: 'undelete',
      kind: 'write',
      method: 'post',
      path: (f) => `/shops/${f.s.shopId}/assets/${f.assetId}/undelete`,
      ok: 409,
    },
  ];
  const call = (
    who: Actor | null,
    e: Endpoint,
    f: Fixture,
    path = e.path(f),
  ) => {
    let req = t.http()[e.method](`/api${path}`);
    if (who) req = req.set(who.auth);
    if (e.method === 'post' && e.name === 'commit')
      req = req.set('Idempotency-Key', `k-${uuidv7()}`);
    return e.body ? req.send(e.body(f)) : req;
  };

  describe('S31 AS-19 who may do what', () => {
    it.each(endpoints)(
      '$name: anonymous 401, viewer by permission, owner through',
      async (e) => {
        const f = await fixture();
        const viewer = await t.member(f.s.shopId, 'VIEWER');
        expect((await call(null, e, f)).status).toBe(401);

        const asViewer = await call(viewer, e, f);
        if (e.kind === 'write') {
          expect(asViewer.status).toBe(403);
          expect(asViewer.body.code).toBe('permission_denied');
        } else {
          expect(asViewer.status).toBe(e.ok);
        }
        const asOwner = await call(f.s, e, f);
        expect(asOwner.status).toBe(e.ok);
      },
    );

    it('commit: anonymous 401, viewer 403, owner 201', async () => {
      const f = await fixture();
      const viewer = await t.member(f.s.shopId, 'VIEWER');
      const body = {
        path: '/c.txt',
        baseVersion: 0,
        chunks: [],
        sizeBytes: 0,
        deviceId: 'laptop-1',
      };
      const send = (who: Actor | null) => {
        let req = t
          .http()
          .post(`/api/shops/${f.s.shopId}/assets/commit`)
          .set('Idempotency-Key', `k-${uuidv7()}`);
        if (who) req = req.set(who.auth);
        return req.send(body);
      };
      expect((await send(null)).status).toBe(401);
      const denied = await send(viewer);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('permission_denied');
      expect((await send(f.s)).status).toBe(201);
    });

    it('the buyer routes need a session', async () => {
      await t.http().get('/api/me/purchases').expect(401);
      await t.http().post(`/api/me/purchases/${uuidv7()}/download`).expect(401);
    });

    it('a suspended shop refuses writes with 403 and an offboarding one with 409', async () => {
      const owner = await t.user();
      const suspended = await createShop(t.app, owner, { status: 'SUSPENDED' });
      const closing = await createShop(t.app, owner, { status: 'DELETING' });
      const prepare = (shopId: string) =>
        t
          .http()
          .post(`/api/shops/${shopId}/assets/prepare`)
          .set(owner.auth)
          .send({ chunks: [{ hash: 'b'.repeat(64), size: 5 }] });
      const a = await prepare(suspended.id as string);
      expect([a.status, a.body.code]).toEqual([403, 'shop_suspended']);
      const b = await prepare(closing.id as string);
      expect([b.status, b.body.code]).toEqual([409, 'shop_offboarding']);
    });
  });

  describe('S31 AS-20 cross-tenant access', () => {
    it('a member of another shop learns nothing about this shop and changes nothing', async () => {
      const f = await fixture();
      const other = await t.seller();
      const snapshot = async () =>
        JSON.stringify(
          await t.rows(
            `SELECT 'asset' AS k, "id"::text AS v, "status" AS s FROM "Asset" WHERE "shopId" = :id
             UNION ALL SELECT 'version', "assetId"::text || ':' || "version", '' FROM "AssetVersion" v WHERE "assetId" IN (SELECT "id" FROM "Asset" WHERE "shopId" = :id)
             UNION ALL SELECT 'link', "id"::text, COALESCE("revokedAt"::text, '') FROM "AssetShareLink" WHERE "shopId" = :id
             UNION ALL SELECT 'change', "seq"::text, '' FROM "AssetChange" WHERE "shopId" = :id
             UNION ALL SELECT 'digital', "productId"::text, "assetId"::text FROM "DigitalProduct" WHERE "shopId" = :id
             ORDER BY 1, 2`,
            { id: f.s.shopId },
          ),
        );
      const before = await snapshot();

      // another shop's routes: the shop does not exist for this caller
      for (const e of endpoints) {
        const res = await call(other, e, f);
        expect([e.name, res.status, res.body.code]).toEqual([
          e.name,
          404,
          'shop_not_found',
        ]);
      }
      // own shop, foreign asset IDs
      const mine = { ...f, s: other };
      for (const e of endpoints.filter((x) => x.path(f).includes(f.assetId))) {
        const res = await call(other, e, mine);
        expect([e.name, res.status, res.body.code]).toEqual([
          e.name,
          404,
          'asset_not_found',
        ]);
      }
      // linking this shop's product or asset through the caller's own shop
      const ownProduct = await t.product(other);
      const crossProduct = await t
        .http()
        .put(
          `/api/shops/${other.shopId}/products/${f.productId}/digital-asset/${f.copyId}`,
        )
        .set(other.auth);
      expect([crossProduct.status, crossProduct.body.code]).toEqual([
        404,
        'product_not_found',
      ]);
      const crossAsset = await t
        .http()
        .put(
          `/api/shops/${other.shopId}/products/${ownProduct.id}/digital-asset/${f.copyId}`,
        )
        .set(other.auth);
      expect([crossAsset.status, crossAsset.body.code]).toEqual([
        404,
        'asset_not_found',
      ]);
      const crossLink = await t
        .http()
        .delete(
          `/api/shops/${other.shopId}/assets/${f.assetId}/share-links/${f.linkId}`,
        )
        .set(other.auth);
      expect(crossLink.status).toBe(404);

      expect(await snapshot()).toBe(before);
    }, 60_000);
  });
});
