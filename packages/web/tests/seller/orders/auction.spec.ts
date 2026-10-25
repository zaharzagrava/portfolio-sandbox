import { expect, test } from '@playwright/test';
import { NEW_USER_PASSWORD, resetRateLimits, sellerCall, shopPath, uniqueEmail } from '../../helpers';
import { ownerWithShop, tokenOf } from '../cross-cutting/support';
import { API_URL } from '../../helpers';
import { rows, scalar } from '../support/db';
import { readSlices, signIn } from './support';

/**
 * AI QA, orders area (pass 2): the order an auction winner gets (OrderCommandService.createFixedPriceOrder) appears in the
 * seller's list as a Pending slice. Real time: an auction runs at least 10 minutes (AUCTIONS_MIN_DURATION_S) after a 60 s lead,
 * so this one test takes about 12 minutes (map: scripts/aiqa/coverage/orders.tsv).
 */

async function call(method: string, route: string, body: unknown, token: string) {
  const response = await fetch(`${API_URL}${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}

test('[orders.source.auction-order] the winner of an auction has one order, one Pending slice in the seller list with the closing price', async ({ page }) => {
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
