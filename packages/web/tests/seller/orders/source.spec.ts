import { expect, test, type Page } from '@playwright/test';
import { API_URL, shopPath, sellerCall } from '../../helpers';
import { devMailboxLists, joinShopAs, tokenOf } from '../cross-cutting/support';
import { rows, scalar, userId } from '../support/db';
import { readSlices, shopWithOrders, signIn, type Fixture, type Slice } from './support';
import { runSql } from './seed';

/**
 * AI QA, orders area (pass 2), section "how orders come to exist": real checkouts by a buyer, real payments, a real cancel and a
 * hold that runs out, followed from the buyer's action to the rows (BisOrder, BisOrderItem, ShopOrder, StockReservation,
 * Payment) and to the row on the seller's page (map: scripts/aiqa/coverage/orders.tsv).
 */

test.setTimeout(420_000);
test.describe.configure({ mode: 'serial' }); // one buyer and one cart are shared by the tests

let fx: Fixture;
let slices: Slice[];

test.beforeAll(async ({ browser }) => {
  fx = await shopWithOrders(browser, { pending: 2, paid: 1 });
  slices = await readSlices(fx.token, fx.shopId);
});

const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const ordersPath = () => shopPath(fx.shopId, 'orders');
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');
const sliceOf = (orderId: string) => slices.find((slice) => slice.orderId === orderId) as Slice;
const badgeOf = async (page: Page, slice: Slice) => {
  const current = await readSlices(fx.token, fx.shopId); // the list as it is now (other tests add slices)
  const at = current.findIndex((entry) => entry.shopOrderId === slice.shopOrderId);
  expect(at, 'the slice is on the first page').toBeLessThan(20);
  await expect(rowsOf(page).nth(at).locator('th')).toHaveText(slice.shopOrderId.slice(0, 8));
  return rowsOf(page).nth(at).locator('td').first().innerText();
};
const call = async (method: string, route: string, body: unknown, token: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`${API_URL}${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
};

test.beforeEach(async ({ page }) => {
  await signIn(page, fx.owner);
});

test('[orders.source.checkout-creates-slices] a checkout makes one RESERVED order, its lines, one PENDING slice with the sum of the lines and held stock; the slice shows as Pending', async ({ page }) => {
  lines('orders.source.checkout-creates-slices');
  const orderId = fx.orders.pending[0];
  const slice = sliceOf(orderId);
  expect(rows(`select status, currency from "BisOrder" where id='${orderId}'`)).toEqual([['RESERVED', 'EUR']]);
  expect(rows(`select count(*), sum("lineTotalMinor") from "BisOrderItem" where "bisOrderId"='${orderId}'`)).toEqual([['1', String(slice.subtotalMinor)]]);
  expect(rows(`select status, subtotal from "ShopOrder" where "bisOrderId"='${orderId}'`)).toEqual([['PENDING', String(slice.subtotalMinor)]]);
  expect(Number(scalar(`select count(*) from "ShopOrder" where "bisOrderId"='${orderId}'`))).toBe(1);
  expect(rows(`select status, quantity from "StockReservation" where "bisOrderId"='${orderId}'`)).toEqual([['HELD', String(slice.items[0].quantity)]]);
  expect(scalar(`select "userId" from "BisOrder" where id='${orderId}'`)).toBe(userId(fx.buyer.email));
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(slices.length);
  expect(await badgeOf(page, slice)).toBe('Pending');
});

test('[orders.source.payment-marks-paid, orders.db.slice-order-link] a payment moves the order and every slice to PAID with a completed Payment; the badge is Paid', async ({ page }) => {
  lines('orders.source.payment-marks-paid', 'orders.db.slice-order-link');
  const orderId = fx.orders.paid[0];
  const slice = sliceOf(orderId);
  expect(slice.status).toBe('PAID');
  expect(rows(`select status from "BisOrder" where id='${orderId}'`)).toEqual([['PAID']]);
  expect(rows(`select status from "ShopOrder" where "bisOrderId"='${orderId}'`)).toEqual([['PAID']]);
  expect(rows(`select status, amount from "Payment" where "bisOrderId"='${orderId}'`)).toEqual([['COMPLETED', String(slice.subtotalMinor)]]);
  expect(rows(`select status from "StockReservation" where "bisOrderId"='${orderId}'`)).toEqual([['CONVERTED']]);
  expect(scalar(`select ("ShopOrder"."updatedAt" >= "ShopOrder"."createdAt")::text from "ShopOrder" where "bisOrderId"='${orderId}'`)).toBe('true');
  // each status on the page matches the order and payment behind it
  const pending = rows(`select so.status, o.status from "ShopOrder" so join "BisOrder" o on o.id=so."bisOrderId" where so."shopId"='${fx.shopId}' and so.status='PENDING'`);
  expect(new Set(pending.map((row) => row.join('/')))).toEqual(new Set(['PENDING/RESERVED']));
  await page.goto(ordersPath());
  expect(await badgeOf(page, slice)).toBe('Paid');
});

test('[orders.source.cancel-marks-cancelled, orders.db.slice-order-link] a buyer cancel sets the order and the slice CANCELLED (user_cancelled) and frees the stock; the row shows Cancelled', async ({ page }) => {
  lines('orders.source.cancel-marks-cancelled', 'orders.db.slice-order-link');
  const orderId = fx.orders.cancelled;
  const slice = sliceOf(orderId);
  expect(rows(`select status, "cancelReason" from "BisOrder" where id='${orderId}'`)).toEqual([['CANCELLED', 'user_cancelled']]);
  expect(rows(`select status from "ShopOrder" where "bisOrderId"='${orderId}'`)).toEqual([['CANCELLED']]);
  expect(rows(`select status from "StockReservation" where "bisOrderId"='${orderId}'`)).not.toContainEqual(['HELD']);
  await page.goto(ordersPath());
  expect(await badgeOf(page, slice)).toBe('Cancelled');
});

test('[orders.source.cancel-marks-cancelled] an order whose hold runs out is cancelled (hold_expired) by the sweeper and its slice shows Cancelled', async ({ page }) => {
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

test('[orders.source.two-shops-one-order] a cart with two shops gives each shop one row with its own subtotal; the buyer total is the sum', async () => {
  lines('orders.source.two-shops-one-order');
  const orderId = fx.orders.mixed;
  const mine = sliceOf(orderId);
  const theirs = (await readSlices(await tokenOf(fx.owner), fx.otherShopId)).find((slice) => slice.orderId === orderId) as Slice;
  expect(mine.subtotalMinor).toBe(500);
  expect(theirs.subtotalMinor).toBe(3108);
  expect(rows(`select count(*) from "ShopOrder" where "bisOrderId"='${orderId}'`)).toEqual([['2']]);
  expect(scalar(`select total from "BisOrder" where id='${orderId}'`)).toBe(String(mine.subtotalMinor + theirs.subtotalMinor));
  expect(mine.shopOrderId).not.toBe(theirs.shopOrderId);
});

test('[orders.source.cart-not-in-list] lines in a cart that was never checked out are not in the list', async () => {
  lines('orders.source.cart-not-in-list');
  const before = slices.length;
  await call('DELETE', '/api/cart', undefined, fx.buyer.token);
  expect((await call('PUT', `/api/cart/items/${fx.products.cheap}`, { quantity: 2 }, fx.buyer.token)).status).toBeLessThan(300);
  expect((await call('GET', '/api/cart', undefined, fx.buyer.token)).data.items?.length ?? 1).toBeGreaterThan(0);
  expect(await readSlices(fx.token, fx.shopId)).toHaveLength(before);
  expect(Number(scalar(`select count(*) from "ShopOrder" where "shopId"='${fx.shopId}'`))).toBe(before);
  await call('DELETE', '/api/cart', undefined, fx.buyer.token);
});

test('[orders.source.out-of-stock-cancel] two buyers race for the last piece: the loser is refused at once (422) or cancelled for stock, and a cancelled one is listed to the seller as a Cancelled slice (recorded)', async () => {
  lines('orders.source.out-of-stock-cancel');
  const stamp = Date.now().toString(36);
  const made = await sellerCall('POST', `/api/shops/${fx.shopId}/products`, { title: `Orders Scarce ${stamp}`, brand: 'Test', category: `orders-${stamp}`, priceMinor: 100, quantity: 1, description: 'One piece.' }, fx.token);
  expect(made.status).toBe(201);
  const productId = made.data.id as string;
  const email = `orders-scarce-${stamp}@example.com`;
  expect((await fetch(`${API_URL}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'SuperSecurePassword123!' }) })).status).toBeLessThan(300);
  const buyers = [fx.buyer.token, await tokenOf({ email })];
  for (const token of buyers) {
    await call('DELETE', '/api/cart', undefined, token);
    expect((await call('PUT', `/api/cart/items/${productId}`, { quantity: 1 }, token)).status).toBeLessThan(300);
  }
  for (const token of buyers) {
    let cart = await call('GET', '/api/cart', undefined, token);
    for (const line of cart.data.lines as { productId: string }[]) if (line.productId !== productId) await call('PUT', `/api/cart/items/${line.productId}`, { quantity: 0 }, token); // quantity 0 removes a line
    cart = await call('GET', '/api/cart', undefined, token);
    expect(cart.data.lines.map((line: { productId: string }) => line.productId), 'the cart holds only the scarce product').toEqual([productId]);
  }
  const answers = await Promise.all(buyers.map((token) => call('POST', '/api/checkout', {}, token, { 'Idempotency-Key': crypto.randomUUID() })));
  const got = answers.map((answer) => answer.status);
  expect(got.filter((status) => status === 202).length >= 1 && got.every((status) => status === 202 || status === 422), JSON.stringify(answers.map((answer) => [answer.status, answer.data?.code]))).toBe(true);
  // whatever the answers were, the one piece went to one order; the other buyer's attempt is a CANCELLED(out_of_stock) order
  await expect
    .poll(async () => (await readSlices(fx.token, fx.shopId)).filter((slice) => slice.items.some((item) => item.productId === productId)).map((slice) => slice.status).sort(), { timeout: 30_000 })
    .toEqual(['CANCELLED', 'PENDING']);
  const orderRows = rows(`select o.status || '/' || coalesce(o."cancelReason",'') from "BisOrder" o join "BisOrderItem" i on i."bisOrderId"=o.id where i."productId"='${productId}' order by 1`).flat();
  expect(orderRows).toEqual(['CANCELLED/out_of_stock', 'RESERVED/']);
  test.info().annotations.push({ type: 'observed', description: `checkout answers ${answers.map((answer) => answer.status).join('/')}; every attempt, also an answer 422, leaves a Cancelled order and slice: ${orderRows.join(', ')}` });
});

test('[orders.source.rls-or-tenancy] a member of the shop who buys from it gets a row like any other buyer (the list is by shop only)', async ({ browser }) => {
  lines('orders.source.rls-or-tenancy');
  test.fixme(!(await devMailboxLists()), 'blocked: no dev outbox, so a member cannot be invited');
  const joined = await joinShopAs(browser, fx.owner, fx.shopId, 'VIEWER');
  try {
    const memberToken = await tokenOf(joined.member);
    await call('DELETE', '/api/cart', undefined, memberToken);
    expect((await call('PUT', `/api/cart/items/${fx.products.cheap}`, { quantity: 1 }, memberToken)).status).toBeLessThan(300);
    const cart = await call('GET', '/api/cart', undefined, memberToken);
    const checkout = await call('POST', '/api/checkout', { expectedTotalMinor: cart.data.totalMinor ?? cart.data.subtotalMinor }, memberToken, { 'Idempotency-Key': crypto.randomUUID() });
    expect(checkout.status, JSON.stringify(checkout.data)).toBe(202);
    const orderId = checkout.data.orderId as string;
    await expect.poll(async () => (await readSlices(fx.token, fx.shopId)).some((slice) => slice.orderId === orderId)).toBe(true);
    // the owner and the member-buyer see the same list, the new row among the others
    const ownerView = await readSlices(fx.token, fx.shopId);
    const memberView = await readSlices(memberToken, fx.shopId);
    expect(memberView.map((slice) => slice.shopOrderId)).toEqual(ownerView.map((slice) => slice.shopOrderId));
    expect(ownerView.find((slice) => slice.orderId === orderId)?.status).toBe('PENDING');
    await joined.page.goto(ordersPath());
    await expect(joined.page.getByRole('region', { name: 'Orders' }).locator('tbody tr')).toHaveCount(ownerView.length > 20 ? 20 : ownerView.length);
  } finally {
    await joined.context.close();
  }
});

test('[orders.source.ledger-not-read] the list shows the gross subtotal only: no fee, payout or net in the answer or on the page', async ({ page }) => {
  lines('orders.source.ledger-not-read');
  const answer = await call('GET', `/api/shops/${fx.shopId}/orders?limit=100`, undefined, fx.token);
  const keys = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) (keys.add(key), walk(inner));
  };
  walk(answer.data);
  await page.goto(ordersPath());
  expect([...keys].filter((key) => key.split(/(?=[A-Z])/).some((word) => /^(fee|fees|payout|net|commission|ledger|payment|tax)$/i.test(word)))).toEqual([]);
  await page.goto(ordersPath());
  await expect(rowsOf(page).first()).toBeVisible();
  expect(await page.getByRole('region', { name: 'Orders' }).innerText()).not.toMatch(/\b(fee|fees|payout|net|commission|ledger)\b/i);
  expect(await page.getByRole('region', { name: 'Orders' }).locator('thead th').allInnerTexts()).toEqual(['Order', 'Status', 'Items', 'Subtotal', 'Date']);
});

test('[orders.source.flash-sale-order] an order that includes a drop (flash sale) line appears in the seller list like any other', async ({ page }) => {
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
