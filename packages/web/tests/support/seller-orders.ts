import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API_URL, NEW_USER_PASSWORD, SEED, readInviteLink, register, resetRateLimits, sellerCall, uniqueEmail } from '../helpers';
import { openShopByApi } from '../seller-setup';

/**
 * Shared set-up of `seller-orders.spec.ts` and `seller-orders.slow.spec.ts` (the seller orders page, W04 AS-83 and its neighbours,
 * and the order slices S10 hands to the seller). Everything goes through the real API, the same calls the screens make; the
 * database helpers read rows back or write rows the checkout cannot make (bulk, same-second slices, a NULL title), only for shops
 * and buyers a test made itself.
 *
 * The orders that need a real checkout and a settled payment (about a minute) are made ONCE per run by `sharedShop` and read by
 * every worker (a file lock in the temp folder), not once per worker or per test.
 */

export type Member = { email: string; password?: string };
export const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';



const tokens = new Map<string, string>();

/** The member's API token (a fresh sign-in once per member and worker; the saved state is read with it, never through the page). */
export async function tokenOf(member: Member): Promise<string> {
  const cached = tokens.get(member.email);
  if (cached) return cached;
  const login = await sellerCall('POST', '/api/auth/login', { email: member.email, password: member.password ?? NEW_USER_PASSWORD });
  expect(login.status, `login ${member.email}: ${JSON.stringify(login.data)}`).toBe(200);
  const token: string = login.data.accessToken.token;
  tokens.set(member.email, token);
  return token;
}

export async function ownerWithShop(page: Page, products: { title: string; quantity?: number; brand?: string; priceMinor?: number }[] = []) {
  const member = await register(page);
  const { shopId, shopName } = await openShopByApi(member);
  const token = await tokenOf(member);
  const productIds: string[] = [];
  for (const product of products) productIds.push(await seedProductFor(member, shopId, product));
  return { member, shopId, shopName, token, productIds };
}

async function seedProductFor(member: Member, shopId: string, product: { title: string; quantity?: number; brand?: string; priceMinor?: number }): Promise<string> {
  const token = await tokenOf(member);
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const created = await sellerCall(
    'POST',
    `/api/shops/${shopId}/products`,
    {
      title: product.title,
      brand: product.brand ?? 'Test',
      category: `seeded-${stamp}`,
      priceMinor: product.priceMinor ?? 1999,
      quantity: product.quantity ?? 5,
      description: 'Product created by a test.',
    },
    token,
  );
  expect(created.status, `create product: ${JSON.stringify(created.data)}`).toBe(201);
  return created.data.id as string;
}

/** A second shop for a member who already has one (the picker and the switcher need two). */
export async function openSecondShop(member: Member, name = `E2E Second ${Date.now().toString(36)}`): Promise<{ shopId: string; shopName: string }> {
  const token = await tokenOf(member);
  const created = await sellerCall('POST', '/api/shops', { name, slug: `e2e-second-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}` }, token);
  expect(created.status, `second shop: ${JSON.stringify(created.data)}`).toBe(201);
  return { shopId: created.data.id as string, shopName: name };
}

/** The platform admin suspends (or reinstates) a shop through the real API. */
export async function setSuspended(shopId: string, suspended: boolean): Promise<void> {
  const login = await sellerCall('POST', '/api/auth/login', { email: SEED.admin, password: SEED.password });
  expect(login.status).toBe(200);
  const result = await sellerCall('POST', `/api/admin/shops/${shopId}/${suspended ? 'suspend' : 'reinstate'}`, { reason: 'hardening test' }, login.data.accessToken.token);
  expect(result.status).toBe(200);
}

/** The dev outbox lists invitation mails; without it a VIEWER cannot be made (the same block as `seller-team.spec.ts`). */
export async function devMailboxLists(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/api/dev/mailbox?to=${encodeURIComponent(uniqueEmail('probe'))}`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Makes a registered person a member of the shop with `role`: the owner invites through the API, the person opens the mailed
 * link and presses "Accept invitation" (the only way to a non-owner role). Returns the signed-in page and its context; the caller
 * closes the context.
 */
export async function joinShopAs(browser: Browser, owner: Member, shopId: string, role: 'VIEWER' | 'STAFF' | 'ADMIN'): Promise<{ page: Page; context: BrowserContext; member: Required<Member> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const registered = await register(page);
  const invited = await sellerCall('POST', `/api/shops/${shopId}/invites`, { email: registered.email, role }, await tokenOf(owner));
  expect(invited.status, `invite: ${JSON.stringify(invited.data)}`).toBe(201);
  await page.goto(await readInviteLink(registered.email));
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/seller/${shopId}$`));
  return { page, context, member: registered };
}

export type Seen = { method: string; path: string; status: number | null };

/**
 * Records every `/api/` request the page sends (method, path, answer status). The count of requests is part of what the
 * concurrency specs assert: one press of a button is one request, however fast the second press comes.
 */
export function watchApi(page: Page) {
  const seen: Seen[] = [];
  const bySent = new Map<unknown, Seen>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    const entry: Seen = { method: request.method(), path: url.pathname, status: null };
    seen.push(entry);
    bySent.set(request, entry);
  });
  page.on('response', (response) => {
    const entry = bySent.get(response.request());
    if (entry) entry.status = response.status();
  });
  return {
    seen,
    matching: (method: string, path: RegExp) => seen.filter((entry) => entry.method === method && path.test(entry.path)),
    count: (method: string, path: RegExp) => seen.filter((entry) => entry.method === method && path.test(entry.path)).length,
    /** Everything that is not a read. */
    writes: () => seen.filter((entry) => entry.method !== 'GET' && entry.method !== 'HEAD' && entry.method !== 'OPTIONS'),
    reset: () => {
      seen.length = 0;
    },
  };
}



/**
 * Read-only SQL for the AI QA specs: the saved rows are read back from the dev stack's Postgres (the docker container of the
 * stack), never through the page. Returns the rows as arrays of text columns.
 */
const CONTAINER = process.env.AIQA_DB_CONTAINER ?? 'payment_system_db';

export function rows(sql: string): string[][] {
  const out = execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'marketplace', '-At', '-F', '\t', '-c', sql], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
}

export const scalar = (sql: string): string => rows(sql)[0]?.[0] ?? '';

/** The id of the user with this email. */
export const userId = (email: string): string => scalar(`select id from "User" where email='${email.replace(/'/g, "''")}'`);

/** Moves one of the test's own shops to a status the screens cannot reach (SUSPENDED, DELETING, DELETED). */
export function setShopStatus(shopId: string, status: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED'): void {
  execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', `update "Shop" set status='${status}' where id='${shopId}'`]);
}



/**
 * Rows for the orders specs that must exist in bulk or in a shape the checkout cannot make (same-second slices, a NULL title,
 * a slice with no shop, a BisOrder with a different status). Written straight into the dev stack's Postgres, only for shops
 * and buyers the test made itself. Nothing here is a way to test the page: the page and the API still read them.
 */


export type SeedSlice = {
  /** ShopOrder.id; give it to control the tie order of equal timestamps. */
  id?: string;
  status?: 'PENDING' | 'PAID' | 'CANCELLED' | 'REFUNDED';
  /** BisOrder.status (default follows the slice: PENDING -> RESERVED, PAID -> PAID, CANCELLED -> CANCELLED, REFUNDED -> REFUNDED). */
  orderStatus?: string;
  cancelReason?: string | null;
  createdAt: string;
  subtotal?: number;
  currency?: string;
  /** number of lines of this shop (default 1); `nullTitle` leaves the title NULL, `nullLineTotal` leaves lineTotalMinor NULL. */
  lines?: number;
  nullTitle?: boolean;
  nullLineTotal?: boolean;
  /** ShopOrder.shopId NULL (the shop is gone). */
  noShop?: boolean;
};

const q = (value: string) => `'${value.replace(/'/g, "''")}'`;
const DEFAULT_ORDER_STATUS = { PENDING: 'RESERVED', PAID: 'PAID', CANCELLED: 'CANCELLED', REFUNDED: 'REFUNDED' } as const;

export function runSql(sql: string): string {
  return execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'marketplace', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { encoding: 'utf8' });
}

/** Inserts the slices (one BisOrder + one ShopOrder + lines each) and returns their ids in the order given. */
export function seedSlices(shopId: string, buyerId: string, slices: SeedSlice[]): { shopOrderId: string; orderId: string }[] {
  const out: { shopOrderId: string; orderId: string }[] = [];
  const statements: string[] = [];
  for (const slice of slices) {
    const shopOrderId = slice.id ?? crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const status = slice.status ?? 'PENDING';
    const subtotal = slice.subtotal ?? 1000;
    out.push({ shopOrderId, orderId });
    statements.push(
      `insert into "BisOrder"(id,"userId","createdAt","updatedAt",status,total,currency,"cancelReason") values (${q(orderId)},${q(buyerId)},${q(slice.createdAt)},${q(slice.createdAt)},${q(slice.orderStatus ?? DEFAULT_ORDER_STATUS[status])},${subtotal},${q(slice.currency ?? 'EUR')},${slice.cancelReason !== undefined && slice.cancelReason !== null ? q(slice.cancelReason) : status === 'CANCELLED' && slice.cancelReason === undefined ? q('user_cancelled') : 'null'})`,
      `insert into "ShopOrder"(id,"bisOrderId","shopId",subtotal,status,"createdAt","updatedAt") values (${q(shopOrderId)},${q(orderId)},${slice.noShop ? 'null' : q(shopId)},${subtotal},${q(status)},${q(slice.createdAt)},${q(slice.createdAt)})`,
    );
    const lines = slice.lines ?? 1;
    for (let line = 0; line < lines; line += 1) {
      const each = Math.floor(subtotal / lines);
      statements.push(
        `insert into "BisOrderItem"(id,"bisOrderId","productId",quantity,"priceAtPurchase","createdAt","updatedAt","shopId",title,"discountMinor","lineTotalMinor") values (${q(crypto.randomUUID())},${q(orderId)},${q(crypto.randomUUID())},1,${each},${q(slice.createdAt)},${q(slice.createdAt)},${q(shopId)},${slice.nullTitle ? 'null' : q(`Seeded line ${line + 1}`)},0,${slice.nullLineTotal ? 'null' : each})`,
      );
    }
  }
  runSql(statements.join(';\n'));
  return out;
}



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



/**
 * `shopWithOrders` once per run: the first worker that asks makes it (a lock folder in the temp folder, named after the runner's
 * process), every other worker waits for the saved ids and reads the same shop. Tokens are not saved; each worker signs in again.
 * Read-only tests only: a test that adds or changes orders makes its own shop.
 */
export async function sharedShop(browser: Browser, name: string, counts: { pending: number; paid: number }): Promise<Fixture> {
  const dir = path.join(os.tmpdir(), `pw-seller-orders-${process.ppid}`);
  const lock = path.join(dir, `${name}.lock`);
  const saved = path.join(dir, `${name}.json`);
  fs.mkdirSync(dir, { recursive: true });
  let mine = false;
  try {
    fs.mkdirSync(lock);
    mine = true;
  } catch {
    if (!fs.existsSync(saved) && Date.now() - fs.statSync(lock).mtimeMs > 20 * 60_000) {
      fs.rmSync(lock, { recursive: true }); // left by a run that died
      fs.mkdirSync(lock);
      mine = true;
    }
  }
  if (mine) {
    const made = await shopWithOrders(browser, counts);
    const { token: _t, buyer, ...rest } = made;
    void _t;
    fs.writeFileSync(saved, JSON.stringify({ ...rest, buyerEmail: buyer.email }));
    return made;
  }
  await expect.poll(() => fs.existsSync(saved), { timeout: 600_000, intervals: [500] }).toBe(true);
  const data = JSON.parse(fs.readFileSync(saved, 'utf8')) as Omit<Fixture, 'token' | 'buyer'> & { buyerEmail: string };
  const { buyerEmail, ...rest } = data;
  return { ...rest, token: await tokenOf(rest.owner), buyer: { email: buyerEmail, token: await tokenOf({ email: buyerEmail }) } };
}
