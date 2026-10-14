import { randomUUID } from 'node:crypto';
import { rows } from './orders-app';
import { seedSeller, type FlashTestApp, type Seller } from './flash-kit';

/** Shared steps of the flash-sale specs (S11): open sales, carts, checkouts and readers of the persisted state. */

export const MIN = 60_000;
export const T = new Date('2026-10-14T12:00:00.000Z');
export const at = (ms: number) => new Date(T.getTime() + ms);
export const DROP_PRICE = 49_900;
export const REGULAR_PRICE = 59_900;

export type User = Awaited<ReturnType<FlashTestApp['newUser']>>;

export interface Drop {
  id: string;
  productId: string;
  seller: Seller;
  units: number;
  buckets: number;
}

/**
 * `count` loaded sales (one product each, `regular` units of stock besides the drop) open from T + 10 min: scheduled
 * through the route, loaded by the load handler, the clock then at the start. Create users afterwards.
 */
export async function openDrops(
  t: FlashTestApp,
  count: number,
  over: {
    units?: number;
    buckets?: number;
    limit?: number;
    rate?: number;
    regular?: number;
    startsInMin?: number;
  } = {},
): Promise<Drop[]> {
  const units = over.units ?? 30;
  const buckets = over.buckets ?? 8;
  const regular = over.regular ?? 5;
  t.clock.set(T);
  const seller = await seedSeller(
    t,
    Array.from({ length: count }, () => ({
      priceMinor: REGULAR_PRICE,
      quantity: units + regular,
    })),
  );
  const drops: Drop[] = [];
  for (const product of seller.products) {
    const res = await t
      .as(seller.owner)
      .post(`/api/shops/${seller.shop.id}/flash-sales`)
      .send({
        productId: product.id,
        priceMinor: DROP_PRICE,
        units,
        buckets,
        perUserLimit: over.limit ?? 1,
        admissionRatePerSecond: over.rate ?? 2000,
        startsAt: at(10 * MIN).toISOString(),
        endsAt: at(70 * MIN).toISOString(),
      });
    if (res.status !== 201) throw new Error(`sale not created: ${res.status}`);
    drops.push({
      id: res.body.id,
      productId: product.id,
      seller,
      units,
      buckets,
    });
  }
  t.clock.set(at(9 * MIN));
  for (const d of drops) await t.jobs.load({ saleId: d.id });
  t.clock.set(at(10 * MIN));
  return drops;
}

export const openDrop = async (
  t: FlashTestApp,
  over: Parameters<typeof openDrops>[2] = {},
) => (await openDrops(t, 1, over))[0];

export const newKey = () => `key-${randomUUID()}`;

export async function addToCart(
  t: FlashTestApp,
  user: User,
  productId: string,
  quantity: number,
): Promise<void> {
  const res = await t
    .as(user)
    .put(`/api/cart/items/${productId}`)
    .send({ quantity });
  if (res.status !== 200) throw new Error(`cart: ${res.status}`);
}

export const checkoutAs = (
  t: FlashTestApp,
  user: User,
  key = newKey(),
  body?: object,
) => {
  const req = t.as(user).post('/api/checkout').set('Idempotency-Key', key);
  return body === undefined ? req : req.send(body);
};

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export const countRows = async (t: FlashTestApp, table: string) =>
  Number(
    (
      await rows<{ n: string }>(t.app, `SELECT count(*) AS n FROM "${table}"`)
    )[0].n,
  );

export const reservationsOf = (t: FlashTestApp, saleId: string) =>
  rows<{
    id: string;
    status: string;
    source: string;
    quantity: number;
    sourceRef: string;
    bisOrderId: string;
    flashSaleId: string;
    nextReleaseAt: Date | null;
  }>(
    t.app,
    `SELECT "id", "status", "source", "quantity", "sourceRef", "bisOrderId", "flashSaleId", "nextReleaseAt"
     FROM "StockReservation" WHERE "flashSaleId" = :saleId ORDER BY "createdAt", "id"`,
    { saleId },
  );

export const orderStatus = async (t: FlashTestApp, orderId: string) =>
  (
    await rows<{ status: string; cancelReason: string | null }>(
      t.app,
      `SELECT "status", "cancelReason" FROM "BisOrder" WHERE "id" = :orderId`,
      { orderId },
    )
  )[0];

/** Moves the clock and signs the given users in again (access tokens expire with the clock). */
export async function advance(
  t: FlashTestApp,
  ms: number,
  ...users: User[]
): Promise<void> {
  t.clock.set(new Date(t.clock.nowMs() + ms));
  for (const u of users) await t.reauth(u);
}

export const claimState = (t: FlashTestApp, saleId: string, claimId: string) =>
  t.redis.hget(`flash:{${saleId}:claim:${claimId}}`, 'state');
