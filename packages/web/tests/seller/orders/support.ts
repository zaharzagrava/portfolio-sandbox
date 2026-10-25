import { expect, type Browser, type Page } from '@playwright/test';
import { API_URL, NEW_USER_PASSWORD, register, resetRateLimits, sellerCall } from '../../helpers';
import { openSecondShop, ownerWithShop, tokenOf, type Member } from '../cross-cutting/support';

/**
 * Set-up of the orders-area specs (`orders-page.spec.ts`, `orders-list.spec.ts`). Everything goes through the real API, the same
 * calls the screens make: a seller with a shop and products, a buyer who checks out and pays, and a read of the shop's order
 * slices with the seller's token to compare with what the page shows.
 */

export type Slice = {
  shopOrderId: string;
  orderId: string;
  status: 'PENDING' | 'PAID' | 'CANCELLED' | 'REFUNDED';
  subtotalMinor: number;
  currency: string;
  buyerId: string;
  createdAt: string;
  items: { productId: string; shopId: string; quantity: number; unitPriceMinor: number; discountMinor: number; lineTotalMinor: number }[];
};

async function call(method: string, route: string, body: unknown, token: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${API_URL}${route}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}

/** Every slice of the shop, newest first (the same keyset pages the screen reads, 100 at a time). */
export async function readSlices(token: string, shopId: string): Promise<Slice[]> {
  const all: Slice[] = [];
  let cursor: string | null = null;
  do {
    const result = await call('GET', `/api/shops/${shopId}/orders?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, token);
    expect(result.status, `read orders: ${JSON.stringify(result.data)}`).toBe(200);
    all.push(...(result.data.items as Slice[]));
    cursor = result.data.nextCursor as string | null;
  } while (cursor);
  return all;
}

export type Fixture = {
  owner: Member;
  shopId: string;
  shopName: string;
  token: string;
  otherShopId: string;
  products: { cheap: string; mid: string; other: string };
  buyer: { token: string; email: string };
  /** The order ids (BisOrder) of the orders made, by the role they play in the specs. */
  orders: { multiLine: string; mixed: string; cancelled: string; paid: string[]; pending: string[] };
};

/** Signs `member` in on `page` with the same two calls the sign-in form makes. */
export async function signIn(page: Page, member: Member) {
  await resetRateLimits();
  const signedIn = await page.request.post('/api/bff/session', { data: { email: member.email, password: member.password ?? NEW_USER_PASSWORD } });
  expect(signedIn.status(), `sign in ${member.email}: ${await signedIn.text()}`).toBeLessThan(300);
}

/**
 * A seller with a shop (two products, 250 and 1999 minor units), a second shop with one product, and a buyer who makes
 * `pending + paid` orders of one line (quantity 1 to 3), one order of two lines, one order across both shops and one
 * cancelled order. Paid orders are really paid (the sandbox card) and awaited, so their slices are PAID.
 */
export async function shopWithOrders(browser: Browser, counts: { pending: number; paid: number }): Promise<Fixture> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const seller = await ownerWithShop(page, []);
    const make = async (shopId: string, token: string, title: string, priceMinor: number) => {
      const created = await sellerCall('POST', `/api/shops/${shopId}/products`, { title, brand: 'Test', category: `orders-${stamp}`, priceMinor, quantity: 1000, description: `${title} made by a test.` }, token);
      expect(created.status, `create product: ${JSON.stringify(created.data)}`).toBe(201);
      return created.data.id as string;
    };
    const cheap = await make(seller.shopId, seller.token, `Orders Cheap ${stamp}`, 250);
    const mid = await make(seller.shopId, seller.token, `Orders Mid ${stamp}`, 1999);
    const second = await openSecondShop(seller.member);
    const other = await make(second.shopId, seller.token, `Orders Other ${stamp}`, 777);

    const buyerEmail = `orders-buyer-${stamp}@example.com`;
    await resetRateLimits();
    const registered = await sellerCall('POST', '/api/auth/register', { email: buyerEmail, password: NEW_USER_PASSWORD });
    expect(registered.status, `register buyer: ${JSON.stringify(registered.data)}`).toBeLessThan(300);
    const buyerToken = await tokenOf({ email: buyerEmail });
    // Checkout is accepted at once and the order rows follow; the slices of the shop tell when the order exists.
    const place = async (lines: [string, number][]) => {
      await call('DELETE', '/api/cart', undefined, buyerToken);
      for (const [productId, quantity] of lines) expect((await call('PUT', `/api/cart/items/${productId}`, { quantity }, buyerToken)).status).toBeLessThan(300);
      const cart = await call('GET', '/api/cart', undefined, buyerToken);
      const checkout = await call('POST', '/api/checkout', { expectedTotalMinor: cart.data.totalMinor ?? cart.data.subtotalMinor }, buyerToken, { 'Idempotency-Key': crypto.randomUUID() });
      expect(checkout.status, `checkout: ${JSON.stringify(checkout.data)}`).toBe(202);
      const orderId = checkout.data.orderId as string;
      await expect.poll(async () => (await readSlices(seller.token, seller.shopId)).concat(await readSlices(seller.token, second.shopId)).some((slice) => slice.orderId === orderId), { timeout: 30_000 }).toBe(true);
      return orderId;
    };

    const orders: Fixture['orders'] = { multiLine: '', mixed: '', cancelled: '', paid: [], pending: [] };
    for (let index = 0; index < counts.paid; index += 1) orders.paid.push(await place([[cheap, 1 + (index % 3)]]));
    for (let index = 0; index < counts.pending; index += 1) orders.pending.push(await place([[cheap, 1 + (index % 3)]]));
    orders.multiLine = await place([[cheap, 2], [mid, 3]]);
    orders.mixed = await place([[cheap, 2], [other, 4]]);
    orders.cancelled = await place([[mid, 1]]);
    expect((await call('POST', `/api/orders/${orders.cancelled}/cancel`, {}, buyerToken, { 'Idempotency-Key': crypto.randomUUID() })).status).toBe(200);
    for (const orderId of orders.paid) {
      const paid = await call('POST', '/api/payments/intents', { orderId, paymentMethodId: 'pm_card_visa' }, buyerToken, { 'Idempotency-Key': crypto.randomUUID() });
      expect(paid.status, `pay: ${JSON.stringify(paid.data)}`).toBeLessThan(300);
    }
    await expect
      .poll(async () => (await readSlices(seller.token, seller.shopId)).filter((slice) => slice.status === 'PAID').length, { timeout: 90_000 })
      .toBe(counts.paid);

    return { owner: seller.member, shopId: seller.shopId, shopName: seller.shopName, token: seller.token, otherShopId: second.shopId, products: { cheap, mid, other }, buyer: { token: buyerToken, email: buyerEmail }, orders };
  } finally {
    await context.close();
  }
}

export { register };
