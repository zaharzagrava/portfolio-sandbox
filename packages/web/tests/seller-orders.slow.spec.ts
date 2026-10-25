import { expect, test, type Page } from '@playwright/test';
import { API_URL, NEW_USER_PASSWORD, resetRateLimits, sellerCall, shopPath, uniqueEmail } from './helpers';
import { openSecondShop, ownerWithShop, readSlices, rows, runSql, scalar, shopWithOrders, signIn, tokenOf, userId, type Fixture, type Member, type Slice } from './support/seller-orders';

/**
 * The slow runs of the seller orders area: the 12-minute auction, the hold that runs out (sweeper), the flash-sale start wait and
 * the 10,000-row seed. Never in the normal run: every test skips unless AIQA_SLOW=1 (rule 3 of docs/work/architecture/test-suite-rules.md).
 */

const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');
const BASE = Date.now() - 3_600_000;
void BASE;

test.describe('slow: orders that come to exist over time', () => {
  test.describe.configure({ mode: 'serial', timeout: 480_000 });
  let fx: Fixture;
  let slices: Slice[];
  test.beforeAll(async ({ browser }) => {
    if (!process.env.AIQA_SLOW) return;
    fx = await shopWithOrders(browser, { pending: 2, paid: 0 });
    slices = await readSlices(fx.token, fx.shopId);
  });
  test.beforeEach(async ({ page }) => {
    if (process.env.AIQA_SLOW) await signIn(page, fx.owner);
  });
  const ordersPath = () => shopPath(fx.shopId, 'orders');
  const sliceOf = (orderId: string) => slices.find((slice) => slice.orderId === orderId) as Slice;
  const badgeOf = async (page: Page, slice: Slice) => {
    const current = await readSlices(fx.token, fx.shopId);
    const at = current.findIndex((entry) => entry.shopOrderId === slice.shopOrderId);
    expect(at, 'the slice is on the first page').toBeLessThan(20);
    await expect(rowsOf(page).nth(at).locator('th')).toHaveText(slice.shopOrderId.slice(-8));
    return rowsOf(page).nth(at).locator('td').first().innerText();
  };
  const call = async (method: string, route: string, body: unknown, token: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${API_URL}${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : undefined };
  };

test('S10 AS-36 @desktop: an order whose hold runs out is cancelled (hold_expired) by the sweeper and its slice shows Cancelled', async ({ page }) => {
  test.skip(!process.env.AIQA_SLOW, 'slow: hold expiry sweep');
  lines('orders.source.cancel-marks-cancelled');
  const orderId = fx.orders.pending[1];
  const slice = sliceOf(orderId);
  runSql(`update "BisOrder" set "reservedUntil" = now() - interval '2 minutes' where id='${orderId}' and status='RESERVED'`);
  await expect
    .poll(() => scalar(`select status || '/' || coalesce("cancelReason",'') from "BisOrder" where id='${orderId}'`), { timeout: 180_000, intervals: [3_000] })
    .toBe('CANCELLED/hold_expired');
  expect(rows(`select status from "ShopOrder" where "bisOrderId"='${orderId}'`)).toEqual([['CANCELLED']]);
  await page.goto(ordersPath());
  expect(await badgeOf(page, slice)).toBe('Cancelled');
});

test('W04 AS-83 @desktop: an order that includes a drop (flash sale) line appears in the seller list like any other', async ({ page }) => {
  test.skip(!process.env.AIQA_SLOW, 'slow: flash-sale start wait');
  lines('orders.source.flash-sale-order');
  test.setTimeout(480_000);
  const stamp = Date.now().toString(36);
  const made = await sellerCall('POST', `/api/shops/${fx.shopId}/products`, { title: `Orders Drop ${stamp}`, brand: 'Test', category: `orders-${stamp}`, priceMinor: 1000, quantity: 50, description: 'A drop.' }, fx.token);
  expect(made.status).toBe(201);
  const productId = made.data.id as string;
  const startsAt = new Date(Date.now() + 135_000);
  const sale = await sellerCall('POST', `/api/shops/${fx.shopId}/flash-sales`, { productId, priceMinor: 400, units: 5, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 600_000).toISOString() }, fx.token);
  expect(sale.status, JSON.stringify(sale.data)).toBeLessThan(300);
  const saleId = sale.data.id as string;
  await expect.poll(async () => (await sellerCall('GET', `/api/shops/${fx.shopId}/flash-sales/${saleId}`, undefined, fx.token)).data.status, { timeout: 240_000, intervals: [5_000] }).toBe('LOADED');
  await expect.poll(() => Date.now() >= startsAt.getTime() + 2_000, { timeout: 240_000, intervals: [2_000] }).toBe(true);
  await call('DELETE', '/api/cart', undefined, fx.buyer.token);
  expect((await call('PUT', `/api/cart/items/${productId}`, { quantity: 1 }, fx.buyer.token)).status).toBeLessThan(300);
  const cart = await call('GET', '/api/cart', undefined, fx.buyer.token);
  const checkout = await call('POST', '/api/checkout', { expectedTotalMinor: cart.data.totalMinor ?? cart.data.subtotalMinor }, fx.buyer.token, { 'Idempotency-Key': crypto.randomUUID() });
  expect(checkout.status, JSON.stringify(checkout.data)).toBe(202);
  const orderId = checkout.data.orderId as string;
  await expect.poll(async () => (await readSlices(fx.token, fx.shopId)).some((slice) => slice.orderId === orderId), { timeout: 60_000 }).toBe(true);
  const slice = (await readSlices(fx.token, fx.shopId)).find((entry) => entry.orderId === orderId) as Slice;
  test.info().annotations.push({ type: 'observed', description: `drop order: subtotal ${slice.subtotalMinor}, lines ${JSON.stringify(slice.items)}, rows ${JSON.stringify(rows(`select "flashSaleId", "priceAtPurchase" from "BisOrderItem" where "bisOrderId"='${orderId}'`))}` });
  expect(slice.status).toBe('PENDING');
  expect(slice.subtotalMinor, 'the drop price (400), not the shelf price (1000)').toBe(400);
  // the drop is traced by the stock hold (source FLASH, the sale id); BisOrderItem.flashSaleId stays NULL (recorded in the findings)
  expect(rows(`select source, "flashSaleId"::text, status from "StockReservation" where "bisOrderId"='${orderId}'`)).toEqual([['FLASH', saleId, 'HELD']]);
  expect(rows(`select "priceAtPurchase" from "BisOrderItem" where "bisOrderId"='${orderId}'`)).toEqual([['400']]);
  await page.goto(ordersPath());
  expect(await badgeOf(page, slice)).toBe('Pending');
});
});

test.describe('slow: 10 000 slices', () => {
  test.describe.configure({ timeout: 240_000 });
  let owner: Member;
  let token: string;
  let buyerId: string;
  const ordersPath = (shop: string) => shopPath(shop, 'orders');
  test.beforeAll(async ({ browser }) => {
    if (!process.env.AIQA_SLOW) return;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const made = await ownerWithShop(page, []);
      owner = made.member;
      token = made.token;
      await resetRateLimits();
      const email = uniqueEmail('orders-db-buyer');
      expect((await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
      buyerId = userId(email);
    } finally {
      await context.close();
    }
  });
  const newShop = async () => (await openSecondShop(owner)).shopId;
test('S10 AS-60 @desktop: with 10 000 slices the list reads the keyset index with no sort, first page and a deep page are fast', async ({ page }) => {
  test.skip(!process.env.AIQA_SLOW, 'slow: 10 000-row seed');
  lines('orders.db.keyset-index', 'orders.db.index-use');
  const shop = await newShop();
  runSql(`with g as (select gen_random_uuid() as oid, gen_random_uuid() as sid, i from generate_series(1, 10000) i),
               b as (insert into "BisOrder"(id,"userId","createdAt","updatedAt",status,total,currency) select oid,'${buyerId}', now() - (i || ' seconds')::interval, now(), 'RESERVED', 1000, 'EUR' from g returning id)
          insert into "ShopOrder"(id,"bisOrderId","shopId",subtotal,status,"createdAt","updatedAt") select sid, oid, '${shop}', 1000, 'PENDING', now() - (i || ' seconds')::interval, now() from g;
          analyze "ShopOrder"; analyze "BisOrder"`);
  expect(scalar(`select count(*) from "ShopOrder" where "shopId"='${shop}'`)).toBe('10000');
  const plan = runSql(`explain (analyze, buffers) SELECT so."id", so."bisOrderId" AS "orderId", so."status", so."subtotal", o."currency", so."createdAt"
       FROM "ShopOrder" so JOIN "BisOrder" o ON o."id" = so."bisOrderId"
       WHERE so."shopId" = '${shop}' AND (so."createdAt", so."id") < (now() - interval '5000 seconds', 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid)
       ORDER BY so."createdAt" DESC, so."id" DESC LIMIT 21`);
  expect(plan, plan).toContain('ShopOrder_shop_keyset_idx');
  expect(plan, plan).not.toMatch(/Sort\b/);
  expect(plan, plan).not.toContain('Seq Scan on "ShopOrder"');
  const execution = Number(plan.match(/Execution Time: ([\d.]+) ms/)?.[1]);
  expect(execution, plan).toBeLessThan(100);
  // through the API: first page and a deep page
  const started = Date.now();
  const first = await sellerCall('GET', `/api/shops/${shop}/orders?limit=20`, undefined, token);
  expect(first.status).toBe(200);
  expect(Date.now() - started).toBeLessThan(2000);
  let cursor = first.data.nextCursor as string;
  for (let step = 0; step < 24; step += 1) cursor = (await sellerCall('GET', `/api/shops/${shop}/orders?limit=100&cursor=${encodeURIComponent(cursor)}`, undefined, token)).data.nextCursor ?? cursor;
  const deepStart = Date.now();
  const deep = await sellerCall('GET', `/api/shops/${shop}/orders?limit=20&cursor=${encodeURIComponent(cursor)}`, undefined, token);
  expect(deep.status).toBe(200);
  expect(Date.now() - deepStart).toBeLessThan(2000);
  await signIn(page, owner);
  await page.goto(ordersPath(shop));
  await expect(rowsOf(page)).toHaveCount(20);
});
});

test.describe('slow: auction', () => {
async function call(method: string, route: string, body: unknown, token: string) {
  const response = await fetch(`${API_URL}${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}

test('S10 AS-13 @desktop: the winner of an auction has one order, one Pending slice in the seller list with the closing price', async ({ page }) => {
  test.skip(!process.env.AIQA_SLOW, 'slow: auction');
  test.setTimeout(1_500_000);
  test.info().annotations.push({ type: 'aiqa-lines', description: 'orders.source.auction-order' });
  const made = await ownerWithShop(page, [{ title: 'Orders Auction Lot', quantity: 5, priceMinor: 5000 }]);
  await resetRateLimits();
  const email = uniqueEmail('orders-auction-buyer');
  expect((await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
  const buyer = await tokenOf({ email });
  // auctions are a Pro-plan feature: the shop subscribes to Pro through the real billing route (sandbox card)
  const proPrice = scalar(`select pr.id from "Price" pr join "Plan" p on p.id = pr."planId" where p.code='pro' and pr.interval='MONTH' and pr.active`);
  const subscribed = await fetch(`${API_URL}/api/shops/${made.shopId}/subscription`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${made.token}`, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ priceId: proPrice, paymentMethodRef: 'pm_card_visa' }) });
  expect(subscribed.status, await subscribed.text()).toBeLessThan(300);
  await expect.poll(async () => (await sellerCall('GET', `/api/shops/${made.shopId}/subscription`, undefined, made.token)).data?.entitlements?.auctions, { timeout: 60_000 }).toBe(true);
  const startsAt = new Date(Date.now() + 75_000);
  const endsAt = new Date(startsAt.getTime() + 620_000);
  const created = await call('POST', `/api/shops/${made.shopId}/auctions`, { productId: made.productIds[0], title: 'Orders Auction Lot', startingPriceMinor: 1000, minIncrementMinor: 100, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }, made.token);
  expect(created.status, JSON.stringify(created.data)).toBeLessThan(300);
  const auctionId = created.data.id as string;
  await expect.poll(() => Date.now() >= startsAt.getTime() + 2_000, { timeout: 180_000, intervals: [2_000] }).toBe(true);
  const bid = await call('POST', `/api/auctions/${auctionId}/bids`, { maxAmountMinor: 1500 }, buyer);
  expect(bid.status, JSON.stringify(bid.data)).toBeLessThan(300);
  expect(await readSlices(made.token, made.shopId)).toHaveLength(0);
  // the access token lives 15 minutes and the auction runs about as long: read the end from the database, then sign in again
  await expect.poll(() => scalar(`select coalesce("winnerOrderId"::text,'') from "Auction" where id='${auctionId}'`), { timeout: 900_000, intervals: [10_000] }).not.toBe('');
  const orderId = scalar(`select "winnerOrderId"::text from "Auction" where id='${auctionId}'`);
  const fresh = await sellerCall('POST', '/api/auth/login', { email: made.member.email, password: NEW_USER_PASSWORD });
  const token = fresh.data.accessToken.token as string;
  expect((await sellerCall('GET', `/api/shops/${made.shopId}/auctions/${auctionId}`, undefined, token)).data.winnerOrderId).toBe(orderId);
  await expect.poll(async () => (await readSlices(token, made.shopId)).length, { timeout: 60_000 }).toBe(1);
  const [slice] = await readSlices(token, made.shopId);
  expect(slice.orderId).toBe(orderId);
  expect(slice.status).toBe('PENDING');
  expect(slice.subtotalMinor).toBe(1000);
  expect(rows(`select status from "BisOrder" where id='${orderId}'`)).toEqual([['RESERVED']]);
  expect(rows(`select count(*) from "ShopOrder" where "bisOrderId"='${orderId}'`)).toEqual([['1']]);
  await signIn(page, made.member);
  await page.goto(shopPath(made.shopId, 'orders'));
  await expect(page.getByRole('region', { name: 'Orders' }).locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Orders' }).locator('tbody tr td').first()).toHaveText('Pending');
});

});
