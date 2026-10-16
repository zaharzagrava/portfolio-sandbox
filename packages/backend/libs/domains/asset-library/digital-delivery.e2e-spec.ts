import { v7 as uuidv7 } from 'uuid';
import {
  digitalProductLinkSchema,
  downloadGrantSchema,
  purchasePageSchema,
} from '@marketplace-sandbox/contracts';
import {
  createAssetApp,
  expectContract,
  USERCONTENT_ORIGIN,
  type Actor,
  type AssetTestApp,
  type Seller,
} from './testing/asset-client';
import { deliver, refundedEvent, refundedPayload } from './testing/events';

const pathOf = (url: string) => new URL(url).pathname;

describe('Digital delivery: product link, purchases and buyer downloads', () => {
  let t: AssetTestApp;
  let next = 1;
  beforeAll(async () => {
    t = await createAssetApp();
  });
  afterAll(async () => {
    await t.close();
  });

  /** A shop with a file and a product linked to it. */
  async function listing(over: { title?: string; bytes?: Buffer } = {}) {
    const s = await t.seller();
    const bytes = over.bytes ?? t.randomBytes(25_000);
    const saved = await t.save(s, '/books/guide.pdf', bytes);
    const assetId = saved.commit.body.assetId as string;
    const product = await t.product(s, over.title);
    await t.link(s, product.id, assetId).expect(204);
    return { s, bytes, assetId, productId: product.id };
  }
  const grantRequest = (buyer: Actor, productId: string) =>
    t.http().post(`/api/me/purchases/${productId}/download`).set(buyer.auth);
  /** Anonymous fetches come from a fresh address each: the per-address limit is not what these scenarios test. */
  const fetchUrl = (url: string) =>
    t.rawGet(pathOf(url), {
      forwardedFor: `203.0.113.${100 + (next++ % 150)}`,
    });
  const entitlementRow = async (id: string) =>
    (
      await t.rows<{
        downloadCount: number;
        lastDownloadAt: Date | null;
        assetId: string;
        status: string;
      }>(
        `SELECT "downloadCount", "lastDownloadAt", "assetId", "status" FROM "AssetEntitlement" WHERE "id" = :id`,
        { id },
      )
    )[0];
  const entitlementIdOf = async (orderId: string, productId: string) =>
    (
      await t.rows<{ id: string }>(
        `SELECT "id" FROM "AssetEntitlement" WHERE "orderId" = :orderId AND "productId" = :productId`,
        { orderId, productId },
      )
    )[0]?.id;

  // ------------------------------------------------------------------------------------------------ the link

  it('S31 AS-59: a file is linked to a product, read back, and announced once', async () => {
    const s = await t.seller();
    const saved = await t.save(s, '/books/guide.pdf', t.randomBytes(20_000));
    const assetId = saved.commit.body.assetId as string;
    const product = await t.product(s);

    await t.link(s, product.id, assetId).expect(204);
    const view = await t
      .http()
      .get(`/api/shops/${s.shopId}/products/${product.id}/digital-asset`)
      .set(s.auth)
      .expect(200);
    expect(expectContract(digitalProductLinkSchema, view.body)).toMatchObject({
      productId: product.id,
      assetId,
      fileName: 'guide.pdf',
      sizeBytes: 20_000,
      version: 1,
    });
    const events = () =>
      t
        .outbox(product.id)
        .then((rows) =>
          rows.filter((r) => r.type === 'assets.digital_product_linked'),
        );
    expect(await events()).toHaveLength(1);
    await t.link(s, product.id, assetId).expect(204);
    expect(await events()).toHaveLength(1);

    const other = await t.seller();
    const foreign = await t.product(other);
    expect((await t.link(s, foreign.id, assetId).expect(404)).body.code).toBe(
      'product_not_found',
    );
    expect((await t.link(s, uuidv7(), assetId).expect(404)).body.code).toBe(
      'product_not_found',
    );
    const foreignAsset = await t.save(other, '/x.bin', t.randomBytes(5_000));
    expect(
      (
        await t
          .link(s, product.id, foreignAsset.commit.body.assetId)
          .expect(404)
      ).body.code,
    ).toBe('asset_not_found');
    const gone = await t.save(s, '/gone.bin', t.randomBytes(5_000));
    await t
      .http()
      .delete(`/api/shops/${s.shopId}/assets/${gone.commit.body.assetId}`)
      .set(s.auth)
      .expect(204);
    const second = await t.product(s);
    expect(
      (await t.link(s, second.id, gone.commit.body.assetId).expect(404)).body
        .code,
    ).toBe('asset_not_found');
    expect(
      await t.rows(`SELECT 1 FROM "DigitalProduct" WHERE "productId" = :id`, {
        id: second.id,
      }),
    ).toEqual([]);

    const viewer = await t.member(s.shopId, 'VIEWER');
    await t
      .http()
      .put(
        `/api/shops/${s.shopId}/products/${second.id}/digital-asset/${assetId}`,
      )
      .set(viewer.auth)
      .expect(403);
  });

  it('S31 AS-60: re-linking moves entitlements, unlinking a sold product is refused', async () => {
    const x = await listing();
    const buyer = await t.user();
    const orderId = await t.buy(x.s, buyer, x.productId);
    const entitlement = (await entitlementIdOf(orderId, x.productId))!;

    const second = await t.save(
      x.s,
      '/books/guide-2.pdf',
      t.randomBytes(8_000),
    );
    const a2 = second.commit.body.assetId as string;
    await t.link(x.s, x.productId, a2).expect(204);
    expect((await entitlementRow(entitlement)).assetId).toBe(a2);
    const url = `/api/shops/${x.s.shopId}/products/${x.productId}/digital-asset`;
    expect(
      (await t.http().delete(url).set(x.s.auth).expect(409)).body.code,
    ).toBe('digital_product_sold');

    const free = await t.product(x.s);
    await t.link(x.s, free.id, a2).expect(204);
    await t
      .http()
      .delete(`/api/shops/${x.s.shopId}/products/${free.id}/digital-asset`)
      .set(x.s.auth)
      .expect(204);
    const events = (await t.outbox(free.id)).map((r) => r.type);
    expect(events).toEqual([
      'assets.digital_product_linked',
      'assets.digital_product_unlinked',
    ]);
    expect(
      (
        await t
          .http()
          .delete(`/api/shops/${x.s.shopId}/products/${free.id}/digital-asset`)
          .set(x.s.auth)
          .expect(404)
      ).body.code,
    ).toBe('digital_link_not_found');
    await t
      .http()
      .get(`/api/shops/${x.s.shopId}/products/${free.id}/digital-asset`)
      .set(x.s.auth)
      .expect(404);
  });

  // ------------------------------------------------------------------------------------------ the buyer side

  it('S31 AS-66: My purchases lists the active entitlements of the buyer, newest first, in pages', async () => {
    const buyer = await t.user();
    const rival = await t.user();
    const s = await t.seller();
    const saved = await t.save(s, '/books/guide.pdf', t.randomBytes(12_000));
    const orders: string[] = [];
    const products: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await t.product(s, `Book ${i}`);
      await t.link(s, p.id, saved.commit.body.assetId).expect(204);
      products.push(p.id);
      orders.push(await t.buy(s, buyer, p.id, `Book ${i}`));
      await t.advance(1_000);
    }
    const other = await t.product(s, 'Rival');
    await t.link(s, other.id, saved.commit.body.assetId).expect(204);
    await t.buy(s, rival, other.id, 'Rival');
    // the oldest of the four is refunded
    await deliver(
      t.orders,
      refundedEvent(refundedPayload({ orderId: orders[0], userId: buyer.id })),
    );

    const page = (query: Record<string, unknown>) =>
      t.http().get('/api/me/purchases').query(query).set(buyer.auth);
    const p1 = await page({ limit: 2 }).expect(200);
    const p2 = await page({ limit: 2, cursor: p1.body.nextCursor }).expect(200);
    const pages = [p1, p2].map((p) =>
      expectContract(purchasePageSchema, p.body),
    );
    expect(pages[0].items.map((i) => i.title)).toEqual(['Book 3', 'Book 2']);
    expect(pages[1].items.map((i) => i.title)).toEqual(['Book 1']);
    expect(pages[1].nextCursor).toBeNull();
    expect(pages[0].items[0]).toMatchObject({
      productId: products[3],
      shopId: s.shopId,
      orderId: orders[3],
      fileName: 'guide.pdf',
      sizeBytes: 12_000,
    });
    expect(JSON.stringify(pages)).not.toContain('Rival');
    for (const limit of [0, 101])
      expect((await page({ limit }).expect(400)).body.code).toBe(
        'validation_failed',
      );
    await t.http().get('/api/me/purchases').expect(401);
  });

  it('S31 AS-67: a buyer gets a ten-minute link that serves their file, pinned to one version', async () => {
    const x = await listing();
    const buyer = await t.user();
    const orderId = await t.buy(x.s, buyer, x.productId);
    const entitlement = (await entitlementIdOf(orderId, x.productId))!;

    const res = await grantRequest(buyer, x.productId).expect(200);
    const grant = expectContract(downloadGrantSchema, res.body);
    expect(grant.url.startsWith(`${USERCONTENT_ORIGIN}/api/downloads/`)).toBe(
      true,
    );
    expect(new Date(grant.expiresAt).getTime()).toBe(
      t.clock.now().getTime() + 600_000,
    );
    const row = await entitlementRow(entitlement);
    expect(row.downloadCount).toBe(1);
    expect(row.lastDownloadAt?.getTime()).toBe(t.clock.now().getTime());

    const file = await fetchUrl(grant.url);
    expect(file.status).toBe(200);
    expect(file.body.equals(x.bytes)).toBe(true);
    expect(file.headers['x-licensed-to']).toBe(buyer.id);
    expect(file.headers['content-type']).toBe('application/octet-stream');
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="guide.pdf"; filename*=UTF-8''guide.pdf`,
    );
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(file.headers['referrer-policy']).toBe('no-referrer');
    expect(file.headers['set-cookie']).toBeUndefined();

    const v2 = t.randomBytes(9_000);
    await t.save(x.s, '/books/guide.pdf', v2, { baseVersion: 1 });
    expect((await fetchUrl(grant.url)).body.equals(x.bytes)).toBe(true);
    const again = (await grantRequest(buyer, x.productId).expect(200)).body;
    expect((await fetchUrl(again.url)).body.equals(v2)).toBe(true);
    expect((await entitlementRow(entitlement)).downloadCount).toBe(2);
  });

  it('S31 AS-68: whoever did not buy it gets the same answer as for a product that does not exist', async () => {
    const x = await listing();
    const buyer = await t.user();
    const orderId = await t.buy(x.s, buyer, x.productId);
    const stranger = await t.user();
    const bodies: unknown[] = [];
    const answer = async (who: Actor, productId: string) => {
      const res = await grantRequest(who, productId).expect(404);
      bodies.push({
        code: res.body.code,
        title: res.body.title,
        detail: res.body.detail,
        status: res.body.status,
      });
    };
    await answer(stranger, x.productId);
    await answer(x.s, x.productId); // a member of the selling shop
    await answer(buyer, uuidv7());
    await answer(buyer, 'not-a-uuid');
    await deliver(
      t.orders,
      refundedEvent(refundedPayload({ orderId, userId: buyer.id })),
    );
    await answer(buyer, x.productId); // revoked
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ code: 'entitlement_not_found' });
    await t
      .http()
      .post(`/api/me/purchases/${x.productId}/download`)
      .expect(401);
  });

  it('S31 AS-69: a buyer URL lives until its expiry and every failure looks the same', async () => {
    const x = await listing();
    const buyer = await t.user();
    await t.buy(x.s, buyer, x.productId);
    const grant = (await grantRequest(buyer, x.productId).expect(200)).body;
    const expiresAt = new Date(grant.expiresAt).getTime();

    await t.setTime(new Date(expiresAt - 1_000));
    expect((await fetchUrl(grant.url)).status).toBe(200);
    await t.setTime(new Date(expiresAt));
    const expired = await fetchUrl(grant.url);
    expect(expired.status).toBe(410);

    // a fresh URL, then every way to get it wrong
    const fresh = (await grantRequest(buyer, x.productId).expect(200)).body;
    const token = pathOf(fresh.url).split('/').pop()!;
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const link = await t
      .http()
      .post(`/api/shops/${x.s.shopId}/assets/${x.assetId}/share`)
      .set(x.s.auth)
      .send({ expiresInHours: 1 })
      .expect(201);
    const bodies = [expired.body];
    for (const wrong of [flipped, token.slice(0, 10), '_', link.body.token]) {
      const res = await t.rawGet(`/api/downloads/${wrong}`, {
        forwardedFor: `203.0.113.${100 + (next++ % 150)}`,
      });
      expect(res.status).toBe(410);
      bodies.push(res.body);
    }
    await t.db.query(
      `UPDATE "Asset" SET "status" = 'PURGED' WHERE "id" = :id`,
      { replacements: { id: x.assetId } },
    );
    const purged = await fetchUrl(fresh.url);
    expect(purged.status).toBe(410);
    bodies.push(purged.body);
    const shapes = bodies.map((b) => {
      const doc = JSON.parse(b.toString());
      return {
        type: doc.type,
        title: doc.title,
        status: doc.status,
        detail: doc.detail,
        code: doc.code,
      };
    });
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0].code).toBe('download_unavailable');
  });

  it('S31 AS-72: the 31st download request of a buyer within a minute answers 429', async () => {
    const x = await listing();
    const buyer = await t.user();
    const other = await t.user();
    const orderId = await t.buy(x.s, buyer, x.productId);
    await t.buy(x.s, other, x.productId);
    const entitlement = (await entitlementIdOf(orderId, x.productId))!;
    for (let i = 0; i < 30; i++)
      await grantRequest(buyer, x.productId).expect(200);
    const limited = await grantRequest(buyer, x.productId).expect(429);
    expect(limited.body.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await entitlementRow(entitlement)).downloadCount).toBe(30);
    await grantRequest(other, x.productId).expect(200);
  }, 60_000);
});
