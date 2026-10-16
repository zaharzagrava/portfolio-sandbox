import { v7 as uuidv7 } from 'uuid';
import { assetEventSchemas } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { chunkKey } from './infra/chunk-store';
import { createAssetApp, type AssetTestApp } from './testing/asset-client';
import {
  deliver,
  envelope,
  paidEvent,
  paidPayload,
  refundedEvent,
  refundedPayload,
} from './testing/events';

const pathOf = (url: string) => new URL(url).pathname;

describe('Digital delivery: consumers of orders, products and tenancy events', () => {
  let t: AssetTestApp;
  let next = 1;
  beforeAll(async () => {
    t = await createAssetApp();
  });
  afterAll(async () => {
    await t.close();
  });

  async function listing() {
    const s = await t.seller();
    const bytes = t.randomBytes(20_000);
    const saved = await t.save(s, '/books/guide.pdf', bytes);
    const assetId = saved.commit.body.assetId as string;
    const product = await t.product(s);
    await t.link(s, product.id, assetId).expect(204);
    return { s, bytes, assetId, productId: product.id };
  }
  const entitlements = (orderId: string) =>
    t.rows<{
      id: string;
      productId: string;
      buyerId: string;
      title: string;
      status: string;
      revokedReason: string | null;
    }>(
      `SELECT "id", "productId", "buyerId", "title", "status", "revokedReason" FROM "AssetEntitlement" WHERE "orderId" = :orderId ORDER BY "productId"`,
      { orderId },
    );
  const eventsOf = async (entitlementId: string, type: string) =>
    (await t.outbox(entitlementId)).filter((r) => r.type === type);
  const deadLettered = () =>
    MetricsRegistry.value('assets_entitlement_total', {
      event: 'dead_lettered',
    }) ?? 0;
  const anonymous = (url: string) =>
    t.rawGet(pathOf(url), {
      forwardedFor: `203.0.113.${100 + (next++ % 150)}`,
    });

  it('S31 AS-61: a paid order grants one entitlement per digital product and announces it', async () => {
    const x = await listing();
    const plain = await t.product(x.s, 'Not digital');
    const buyer = await t.user();
    const payload = paidPayload({
      userId: buyer.id,
      lines: [
        {
          productId: x.productId,
          shopId: x.s.shopId,
          title: 'E-book',
          quantity: 3,
        },
        { productId: plain.id, shopId: x.s.shopId, title: 'Mug' },
      ],
    });
    expect(await deliver(t.orders, paidEvent(payload))).toEqual({
      delivered: true,
    });

    const rows = await entitlements(payload.orderId);
    expect(rows).toEqual([
      expect.objectContaining({
        productId: x.productId,
        buyerId: buyer.id,
        title: 'E-book',
        status: 'ACTIVE',
      }),
    ]);
    const granted = await eventsOf(rows[0].id, 'assets.entitlement_granted');
    expect(granted).toHaveLength(1);
    const body = assetEventSchemas['assets.entitlement_granted'].parse(
      granted[0].payload.payload,
    );
    expect(body).toMatchObject({
      entitlementId: rows[0].id,
      orderId: payload.orderId,
      productId: x.productId,
      shopId: x.s.shopId,
      buyerId: buyer.id,
      title: 'E-book',
    });
    expect(granted[0].topic).toBe('assets.events');
  });

  it('S31 AS-62: a duplicate delivery, in sequence or at once, changes nothing', async () => {
    const x = await listing();
    const buyer = await t.user();
    const payload = paidPayload({
      userId: buyer.id,
      lines: [{ productId: x.productId, shopId: x.s.shopId }],
    });
    await deliver(t.orders, paidEvent(payload));
    await deliver(t.orders, paidEvent(payload));
    const racing = paidPayload({
      userId: buyer.id,
      lines: [{ productId: x.productId, shopId: x.s.shopId }],
    });
    await Promise.all([
      deliver(t.orders, paidEvent(racing)),
      deliver(t.orders, paidEvent(racing)),
    ]);

    const first = await entitlements(payload.orderId);
    const second = await entitlements(racing.orderId);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(
      await eventsOf(first[0].id, 'assets.entitlement_granted'),
    ).toHaveLength(1);
    expect(
      await eventsOf(second[0].id, 'assets.entitlement_granted'),
    ).toHaveLength(1);
  });

  describe('S31 AS-63 invalid or foreign messages', () => {
    const valid = (userId: string, productId: string, shopId: string) =>
      paidPayload({ userId, lines: [{ productId, shopId }] });
    it.each([
      [
        'no userId',
        (p: Record<string, unknown>) => ({ ...p, userId: undefined }),
      ],
      [
        'lines that are not an array',
        (p: Record<string, unknown>) => ({ ...p, lines: 'x' }),
      ],
      [
        'orderVersion 0',
        (p: Record<string, unknown>) => ({ ...p, orderVersion: 0 }),
      ],
      [
        'an order ID that is not a UUID',
        (p: Record<string, unknown>) => ({ ...p, orderId: 'order-1' }),
      ],
    ])(
      '%s is dead-lettered with no row and no event',
      async (_name, damage) => {
        const x = await listing();
        const buyer = await t.user();
        const good = valid(buyer.id, x.productId, x.s.shopId);
        const before = deadLettered();
        const bad = damage(good);
        expect(
          await deliver(
            t.orders,
            envelope('order.paid', 'orders', good.orderId, bad),
          ),
        ).toEqual({ delivered: false });
        expect(await entitlements(good.orderId)).toEqual([]);
        expect(deadLettered()).toBe(before + 1);
        // the next message is processed
        expect(await deliver(t.orders, paidEvent(good))).toEqual({
          delivered: true,
        });
        expect(await entitlements(good.orderId)).toHaveLength(1);
      },
    );

    it('an unknown contract version is dead-lettered', async () => {
      const x = await listing();
      const buyer = await t.user();
      const good = valid(buyer.id, x.productId, x.s.shopId);
      const future = { ...paidEvent(good), version: 2 };
      expect(await deliver(t.orders, future)).toEqual({ delivered: false });
      expect(await entitlements(good.orderId)).toEqual([]);
    });

    it("a line of another shop never grants this shop's file", async () => {
      const x = await listing();
      const other = await t.seller();
      const buyer = await t.user();
      const payload = valid(buyer.id, x.productId, other.shopId);
      expect(await deliver(t.orders, paidEvent(payload))).toEqual({
        delivered: true,
      });
      expect(await entitlements(payload.orderId)).toEqual([]);
    });
  });

  it('S31 AS-64: a refund revokes once, closes the door and kills outstanding URLs', async () => {
    const x = await listing();
    const buyer = await t.user();
    const payload = paidPayload({
      userId: buyer.id,
      lines: [{ productId: x.productId, shopId: x.s.shopId }],
    });
    await deliver(t.orders, paidEvent(payload));
    const [e] = await entitlements(payload.orderId);
    const grant = (
      await t
        .http()
        .post(`/api/me/purchases/${x.productId}/download`)
        .set(buyer.auth)
        .expect(200)
    ).body;
    expect((await anonymous(grant.url)).status).toBe(200);

    const refund = refundedPayload({
      orderId: payload.orderId,
      userId: buyer.id,
    });
    await deliver(t.orders, refundedEvent(refund));
    await deliver(t.orders, refundedEvent(refund));

    expect(await entitlements(payload.orderId)).toEqual([
      expect.objectContaining({
        id: e.id,
        status: 'REVOKED',
        revokedReason: 'refunded',
      }),
    ]);
    const revoked = await eventsOf(e.id, 'assets.entitlement_revoked');
    expect(revoked).toHaveLength(1);
    expect(
      assetEventSchemas['assets.entitlement_revoked'].parse(
        revoked[0].payload.payload,
      ).reason,
    ).toBe('refunded');
    expect(
      (
        await t
          .http()
          .post(`/api/me/purchases/${x.productId}/download`)
          .set(buyer.auth)
          .expect(404)
      ).body.code,
    ).toBe('entitlement_not_found');
    const outstanding = await anonymous(grant.url);
    expect(outstanding.status).toBe(410);
    expect(JSON.parse(outstanding.body.toString()).code).toBe(
      'download_unavailable',
    );
    const list = await t
      .http()
      .get('/api/me/purchases')
      .set(buyer.auth)
      .expect(200);
    expect(list.body.items).toEqual([]);
  });

  it('S31 AS-65: events out of order still end with no active entitlement after a refund', async () => {
    const x = await listing();
    const buyer = await t.user();
    const early = paidPayload({
      userId: buyer.id,
      orderVersion: 3,
      lines: [{ productId: x.productId, shopId: x.s.shopId }],
    });
    await deliver(
      t.orders,
      refundedEvent(
        refundedPayload({
          orderId: early.orderId,
          userId: buyer.id,
          orderVersion: 5,
        }),
      ),
    );
    await deliver(t.orders, paidEvent(early));
    await deliver(t.orders, paidEvent(early)); // a replay
    expect(await entitlements(early.orderId)).toEqual([]);

    // paid, refunded, then the paid event again
    const normal = paidPayload({
      userId: buyer.id,
      orderVersion: 3,
      lines: [{ productId: x.productId, shopId: x.s.shopId }],
    });
    await deliver(t.orders, paidEvent(normal));
    await deliver(
      t.orders,
      refundedEvent(
        refundedPayload({ orderId: normal.orderId, userId: buyer.id }),
      ),
    );
    await deliver(t.orders, paidEvent(normal));
    expect((await entitlements(normal.orderId)).map((r) => r.status)).toEqual([
      'REVOKED',
    ]);

    // an order that was never refunded grants as usual
    const fine = paidPayload({
      userId: buyer.id,
      lines: [{ productId: x.productId, shopId: x.s.shopId }],
    });
    await deliver(t.orders, paidEvent(fine));
    expect((await entitlements(fine.orderId)).map((r) => r.status)).toEqual([
      'ACTIVE',
    ]);
  });

  it('S31 AS-70: a deleted product loses its link once and its buyers keep their downloads', async () => {
    const x = await listing();
    const buyer = await t.user();
    const payload = paidPayload({
      userId: buyer.id,
      lines: [{ productId: x.productId, shopId: x.s.shopId }],
    });
    await deliver(t.orders, paidEvent(payload));

    const deleted = (productId: string, shopId: string) =>
      envelope(
        'catalog.product_deleted',
        'products',
        productId,
        { productId, shopId, productVersion: 2 },
        2,
      );
    expect(
      await deliver(t.shopEvents, deleted(x.productId, x.s.shopId)),
    ).toEqual({ delivered: true });
    expect(
      await deliver(t.shopEvents, deleted(x.productId, x.s.shopId)),
    ).toEqual({ delivered: true });
    expect(
      await t.rows(`SELECT 1 FROM "DigitalProduct" WHERE "productId" = :id`, {
        id: x.productId,
      }),
    ).toEqual([]);
    const unlinked = (await t.outbox(x.productId)).filter(
      (r) => r.type === 'assets.digital_product_unlinked',
    );
    expect(unlinked).toHaveLength(1);
    expect((await entitlements(payload.orderId))[0].status).toBe('ACTIVE');
    const grant = (
      await t
        .http()
        .post(`/api/me/purchases/${x.productId}/download`)
        .set(buyer.auth)
        .expect(200)
    ).body;
    expect((await anonymous(grant.url)).body.equals(x.bytes)).toBe(true);

    expect(
      await deliver(
        t.shopEvents,
        envelope(
          'catalog.product_deleted',
          'products',
          x.productId,
          { productId: x.productId },
          3,
        ),
      ),
    ).toEqual({ delivered: false });
    const unknown = uuidv7();
    expect(await deliver(t.shopEvents, deleted(unknown, x.s.shopId))).toEqual({
      delivered: true,
    });
  });

  it('S31 AS-71: a deleted shop loses its library and its entitlements, another shop is untouched', async () => {
    const x = await listing();
    const keep = await listing();
    const buyer = await t.user();
    const payload = paidPayload({
      userId: buyer.id,
      lines: [{ productId: x.productId, shopId: x.s.shopId }],
    });
    await deliver(t.orders, paidEvent(payload));
    const keepOrder = paidPayload({
      userId: buyer.id,
      lines: [{ productId: keep.productId, shopId: keep.s.shopId }],
    });
    await deliver(t.orders, paidEvent(keepOrder));
    const link = await t
      .http()
      .post(`/api/shops/${x.s.shopId}/assets/${x.assetId}/share`)
      .set(x.s.auth)
      .send({ expiresInHours: 5 })
      .expect(201);
    await t
      .http()
      .post(`/api/assets/shared/${link.body.token}/redeem`)
      .set('x-forwarded-for', '203.0.113.9');
    const chunkHashes = (
      await t.rows<{ hash: string }>(
        `SELECT "hash" FROM "AssetChunk" WHERE "shopId" = :id`,
        { id: x.s.shopId },
      )
    ).map((r) => r.hash);
    expect(chunkHashes.length).toBeGreaterThan(0);

    const deleted = (shopId: string) =>
      envelope(
        'tenancy.shop_deleted',
        'tenancy',
        shopId,
        { shopId, shopVersion: 4 },
        4,
      );
    expect(await deliver(t.shopEvents, deleted(x.s.shopId))).toEqual({
      delivered: true,
    });
    expect(await deliver(t.shopEvents, deleted(x.s.shopId))).toEqual({
      delivered: true,
    });

    const count = async (table: string, column = 'shopId') =>
      Number(
        (
          await t.rows<{ n: string }>(
            `SELECT count(*) AS n FROM "${table}" WHERE "${column}" = :id`,
            { id: x.s.shopId },
          )
        )[0].n,
      );
    for (const table of [
      'Asset',
      'AssetChunk',
      'AssetChange',
      'AssetSyncState',
      'AssetShareLink',
      'AssetDownloadGrant',
      'DigitalProduct',
      'AssetVersionChunk',
    ])
      expect(await count(table)).toBe(0);
    expect(
      Number(
        (
          await t.rows<{ n: string }>(
            `SELECT count(*) AS n FROM "AssetVersion" WHERE "assetId" = :id`,
            { id: x.assetId },
          )
        )[0].n,
      ),
    ).toBe(0);
    for (const hash of chunkHashes)
      expect(await t.storage.head(chunkKey(x.s.shopId, hash))).toBeNull();

    const [revoked] = await entitlements(payload.orderId);
    expect(revoked).toMatchObject({
      status: 'REVOKED',
      revokedReason: 'shop_deleted',
    });
    const events = await eventsOf(revoked.id, 'assets.entitlement_revoked');
    expect(events).toHaveLength(1);
    expect(
      assetEventSchemas['assets.entitlement_revoked'].parse(
        events[0].payload.payload,
      ).reason,
    ).toBe('shop_deleted');

    // the other shop is untouched
    expect((await entitlements(keepOrder.orderId))[0].status).toBe('ACTIVE');
    expect(
      await t.storage.head(
        chunkKey(
          keep.s.shopId,
          (
            await t.rows<{ hash: string }>(
              `SELECT "hash" FROM "AssetChunk" WHERE "shopId" = :id LIMIT 1`,
              { id: keep.s.shopId },
            )
          )[0].hash,
        ),
      ),
    ).not.toBeNull();
    expect((await t.download(keep.s, keep.assetId)).equals(keep.bytes)).toBe(
      true,
    );

    expect(
      await deliver(
        t.shopEvents,
        envelope(
          'tenancy.shop_deleted',
          'tenancy',
          x.s.shopId,
          { shopVersion: 4 },
          5,
        ),
      ),
    ).toEqual({ delivered: false });
  });
});
