import { expect, test, type Page } from '@playwright/test';
import { NEW_USER_PASSWORD, resetRateLimits, sellerCall, shopPath, uniqueEmail } from '../../helpers';
import { openSecondShop, ownerWithShop, watchApi, type Member } from '../cross-cutting/support';
import { userId } from '../support/db';
import { readSlices, signIn } from './support';
import { runSql, seedSlices } from './seed';

/**
 * AI QA, orders area (pass 2), section "paging and states": many slices at once (written straight into the database, for a
 * shop and a buyer this spec made), the paging links, the cursor, the empty states and the loading skeleton (map:
 * scripts/aiqa/coverage/orders.tsv). The checkout path is covered by orders-list.spec.ts.
 */

test.setTimeout(240_000);

const BASE = Date.now() - 3_600_000;
const at = (secondsAgo: number) => new Date(BASE - secondsAgo * 1000).toISOString();

let owner: Member;
let token: string;
let buyerId: string;
let shopA: string; // 45 slices, alternating PENDING / PAID
let shopB: string; // 3 slices (a second shop of the same member)
const sized: Record<number, string> = {}; // shops with exactly 0, 5, 20, 21 slices

const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const ordersPath = (shop: string, query = '') => `${shopPath(shop, 'orders')}${query}`;
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');
const refsOf = (page: Page) => rowsOf(page).locator('th').allInnerTexts();

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const made = await ownerWithShop(page, []);
    owner = made.member;
    token = made.token;
    shopA = made.shopId;
    await resetRateLimits();
    const email = uniqueEmail('orders-seed-buyer');
    expect((await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
    buyerId = userId(email);
    expect(buyerId).toMatch(/^[0-9a-f-]{36}$/);
    seedSlices(shopA, buyerId, Array.from({ length: 45 }, (_, index) => ({ status: index % 2 === 0 ? 'PENDING' : 'PAID', createdAt: at(index * 5) })));
    shopB = (await openSecondShop(owner)).shopId;
    seedSlices(shopB, buyerId, [0, 1, 2].map((index) => ({ createdAt: at(index) })));
    for (const count of [0, 5, 20, 21]) {
      sized[count] = (await openSecondShop(owner)).shopId;
      if (count) seedSlices(sized[count], buyerId, Array.from({ length: count }, (_, index) => ({ createdAt: at(index) })));
    }
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ page }) => {
  await signIn(page, owner);
});

test('[orders.paging.next-link, orders.paging.first-page-link, orders.paging.last-page, orders.table.page-size, orders.table.order-newest-first] 45 slices are three pages of 20, 20, 5, newest first, nothing repeated or missing', async ({ page }) => {
  lines('orders.paging.next-link', 'orders.paging.first-page-link', 'orders.paging.last-page', 'orders.table.page-size', 'orders.table.order-newest-first');
  const all = await readSlices(token, shopA);
  expect(all).toHaveLength(45);
  expect(all.map((slice) => slice.createdAt)).toEqual([...all.map((slice) => slice.createdAt)].sort().reverse());
  const api = watchApi(page);
  await page.goto(ordersPath(shopA));
  await expect(rowsOf(page)).toHaveCount(20);
  await expect(page.getByRole('link', { name: 'First page' })).toHaveCount(0);
  const seen: string[] = [...(await refsOf(page))];
  await expect(page.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', /\?cursor=[A-Za-z0-9_\-=.~%]+$/);
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/\?cursor=/);
  await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
  await expect.poll(async () => (await refsOf(page)).join()).not.toBe(seen.join());
  await expect(rowsOf(page)).toHaveCount(20);
  seen.push(...(await refsOf(page)));
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(rowsOf(page)).toHaveCount(5);
  seen.push(...(await refsOf(page)));
  // last page: First page shows, Next page does not
  await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
  expect(seen).toEqual(all.map((slice) => slice.shopOrderId.slice(0, 8)));
  expect(new Set(seen).size).toBe(45);
  // every list read asked for 20 and was answered 200
  const reads = api.matching('GET', /\/orders$/);
  expect(reads.length).toBeGreaterThanOrEqual(3);
  expect(reads.every((entry) => entry.status === 200)).toBe(true);
  await page.getByRole('link', { name: 'First page' }).click();
  await expect(page).toHaveURL(ordersPath(shopA));
  await expect(rowsOf(page)).toHaveCount(20);
  expect(await refsOf(page)).toEqual(all.slice(0, 20).map((slice) => slice.shopOrderId.slice(0, 8)));
});

test('[orders.paging.first-page-link] First page keeps the status filter', async ({ page }) => {
  lines('orders.paging.first-page-link');
  await page.goto(ordersPath(shopA, '?status=PENDING'));
  await expect(rowsOf(page)).toHaveCount(20);
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/status=PENDING&cursor=|cursor=.*status=PENDING/);
  await expect(rowsOf(page)).toHaveCount(3);
  await expect(rowsOf(page).locator('td:nth-of-type(1)')).toHaveText(['Pending', 'Pending', 'Pending']);
  await page.getByRole('link', { name: 'First page' }).click();
  await expect(page).toHaveURL(ordersPath(shopA, '?status=PENDING'));
  await expect(rowsOf(page)).toHaveCount(20);
});

test('[orders.paging.no-nav-when-single, orders.paging.exactly-page-size, orders.state.empty-no-orders] 0, 5, 20 and 21 slices: the paging links appear only for 21', async ({ page }) => {
  lines('orders.paging.no-nav-when-single', 'orders.paging.exactly-page-size', 'orders.state.empty-no-orders');
  await page.goto(ordersPath(sized[0]));
  await expect(page.getByText('No orders yet.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Orders' }).getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Orders' }).getByRole('link')).toHaveCount(0);
  for (const [count, next] of [[5, false], [20, false], [21, true]] as const) {
    await page.goto(ordersPath(sized[count]));
    await expect(rowsOf(page)).toHaveCount(Math.min(count, 20));
    await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(next ? 1 : 0);
    await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(next ? 1 : 0);
    const answer = await sellerCall('GET', `/api/shops/${sized[count]}/orders?limit=20`, undefined, token);
    expect(answer.data.items).toHaveLength(Math.min(count, 20));
    expect(answer.data.nextCursor === null).toBe(!next);
  }
});

test('[orders.api.limit-bounds, orders.api.status-validation, orders.api.shop-id-validation] limit and status are checked by the API; a mismatching X-Shop-Id is refused', async () => {
  lines('orders.api.limit-bounds', 'orders.api.status-validation', 'orders.api.shop-id-validation');
  const get = (query: string, headers: Record<string, string> = {}, shop = shopA) =>
    fetch(`${process.env.API_URL ?? 'http://localhost:8000'}/api/shops/${shop}/orders${query}`, { headers: { authorization: `Bearer ${token}`, ...headers } }).then(async (response) => ({ status: response.status, body: (await response.json().catch(() => null)) as { items?: unknown[]; code?: string } | null }));
  expect((await get('')).body?.items).toHaveLength(20);
  expect((await get('?limit=1')).body?.items).toHaveLength(1);
  expect((await get('?limit=100')).body?.items).toHaveLength(45);
  for (const bad of ['0', '101', 'abc', '1.5', '-1', '']) expect((await get(`?limit=${bad}`)).status, `limit=${bad}`).toBe(400);
  for (const good of ['PENDING', 'PAID', 'CANCELLED', 'REFUNDED']) expect((await get(`?status=${good}`)).status, good).toBe(200);
  for (const bad of ['RESERVED', 'paid', '', 'PAID&status=PENDING']) expect((await get(`?status=${bad}`)).status, `status=${bad}`).toBe(400);
  expect((await get('?status=PAID&status=PENDING')).status).toBe(400);
  const notUuid = await get('', {}, 'not-a-uuid');
  expect(notUuid.status).toBe(404);
  expect(notUuid.body?.code).toBe('shop_not_found');
  const mismatch = await get('', { 'X-Shop-Id': shopB });
  expect(mismatch.status, JSON.stringify(mismatch.body)).toBeGreaterThanOrEqual(400);
  expect(mismatch.body?.code).toBe('shop_mismatch');
});

test('[orders.table.busy-keeps-rows, orders.paging.hidden-while-busy] while the next page loads the old rows stay, dimmed, the table is busy and the paging links are hidden (W04.AS-31)', async ({ page }) => {
  lines('orders.table.busy-keeps-rows', 'orders.paging.hidden-while-busy');
  await page.goto(ordersPath(shopA));
  await expect(rowsOf(page)).toHaveCount(20);
  const before = await refsOf(page);
  // a slow server: the page's own server read (the navigation request) is held back
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(/_rsc=/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByRole('link', { name: 'Next page' }).click();
  const table = page.getByRole('region', { name: 'Orders' }).locator('table');
  try {
    // the person pressed Next page: the old rows stay and the table says it is busy, dimmed, with no paging links
    await expect(table).toHaveAttribute('aria-busy', 'true', { timeout: 3000 });
    expect(await refsOf(page)).toEqual(before);
    await expect(table).toHaveClass(/opacity-60/);
    await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(0);
  } finally {
    release();
  }
  await expect.poll(async () => (await refsOf(page)).join()).not.toBe(before.join());
  await expect(table).toHaveAttribute('aria-busy', 'false');
});

test('[orders.state.empty-no-flash] while the next view loads (page or filter) the empty box never shows and the old rows stay', async ({ page }) => {
  lines('orders.state.empty-no-flash');
  await page.goto(ordersPath(shopA));
  await expect(rowsOf(page)).toHaveCount(20);
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __emptySeen: string[] }).__emptySeen = seen;
    new MutationObserver(() => {
      if (document.body.innerText.includes('No orders')) seen.push(document.body.innerText.slice(0, 80));
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const held = new Promise<void>((resolve) => (reached = resolve));
  await page.route(/_rsc=|\/api\/shops\/[^/]+\/orders\?/, async (route) => {
    reached();
    await gate;
    await route.continue();
  });
  await page.getByLabel('Status').selectOption('PAID');
  await held; // a request is out and held: nothing may flash while it is
  expect(await rowsOf(page).count()).toBe(20);
  release();
  await expect(page).toHaveURL(/status=PAID/);
  await expect(rowsOf(page)).toHaveCount(20);
  expect(await page.evaluate(() => (window as unknown as { __emptySeen: string[] }).__emptySeen)).toEqual([]);
});

test('[orders.paging.back-button] Back after Next page returns to the previous rows; the cursor lives only in the address', async ({ page }) => {
  lines('orders.paging.back-button');
  await page.goto(ordersPath(shopA));
  await expect(rowsOf(page)).toHaveCount(20);
  const first = await refsOf(page);
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/cursor=/);
  await expect.poll(async () => (await refsOf(page)).join()).not.toBe(first.join());
  await page.goBack();
  await expect(page).toHaveURL(ordersPath(shopA));
  await expect.poll(async () => (await refsOf(page)).join()).toBe(first.join());
  await page.goForward();
  await expect(page).toHaveURL(/cursor=/);
  expect(await page.evaluate(() => JSON.stringify([localStorage.length, sessionStorage.length]))).toBe('[0,0]');
});

test('[orders.paging.cursor-bound-to-shop, orders.paging.go-to-first-page-button, orders.api.json-error-shape, orders.state.error-4xx-no-retry] a cursor of shop A on shop B is refused 400 invalid_cursor, once, and the panel offers the first page', async ({ page }) => {
  lines('orders.paging.cursor-bound-to-shop', 'orders.paging.go-to-first-page-button', 'orders.api.json-error-shape', 'orders.state.error-4xx-no-retry');
  const firstPage = await sellerCall('GET', `/api/shops/${shopA}/orders?limit=20`, undefined, token);
  const cursor = firstPage.data.nextCursor as string;
  expect(cursor).toBeTruthy();
  const direct = await sellerCall('GET', `/api/shops/${shopB}/orders?limit=20&cursor=${encodeURIComponent(cursor)}`, undefined, token);
  expect(direct.status).toBe(400);
  expect(direct.data.code).toBe('invalid_cursor');
  expect(direct.data.requestId ?? direct.data.request_id).toBeTruthy();
  const api = watchApi(page);
  await page.goto(ordersPath(shopB, `?status=PAID&cursor=${encodeURIComponent(cursor)}`));
  await expect(page.getByText('That page link is no longer valid.')).toBeVisible();
  const reads = api.matching('GET', /\/orders$/);
  expect(reads.map((entry) => entry.status)).toEqual([400]); // asked once, not retried
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Go to the first page' }).click();
  // recorded: where it goes (the status filter is kept or not)
  await expect(page).toHaveURL(ordersPath(shopB));
  await expect(rowsOf(page)).toHaveCount(3);
});

test('[orders.paging.cursor-tampered] a hand-made cursor is dropped by the page or refused 400 invalid_cursor, never a 500', async ({ page }) => {
  lines('orders.paging.cursor-tampered');
  const real = (await sellerCall('GET', `/api/shops/${shopA}/orders?limit=20`, undefined, token)).data.nextCursor as string;
  const decoded = (() => {
    try {
      return Buffer.from(real, 'base64url').toString('utf8');
    } catch {
      return '';
    }
  })();
  const variants: Record<string, string> = {
    random: 'abcdef',
    wrongTag: Buffer.from(decoded.replace(/^[^|:.]*/, 'zz')).toString('base64url'),
    badDate: Buffer.from('2026-99-99T00:00:00.000Z|11111111-1111-4111-8111-111111111111').toString('base64url'),
    truncated: real.slice(0, Math.floor(real.length / 2)),
    badChars: 'a b$c',
    long: 'A'.repeat(600),
    percent: '%25%25',
  };
  for (const [name, cursor] of Object.entries(variants)) {
    const direct = await sellerCall('GET', `/api/shops/${shopA}/orders?limit=20&cursor=${encodeURIComponent(cursor)}`, undefined, token);
    expect(direct.status, `${name}: ${JSON.stringify(direct.data)}`).toBe(400);
    expect(direct.data.code, name).toMatch(/invalid_cursor|validation_failed/);
  }
  for (const name of ['random', 'wrongTag', 'badDate', 'truncated']) {
    await page.goto(ordersPath(shopA, `?cursor=${encodeURIComponent(variants[name])}`));
    await expect(page.getByText('That page link is no longer valid.'), name).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the first page' })).toBeVisible();
  }
  const api = watchApi(page);
  for (const name of ['badChars', 'long']) {
    api.reset();
    await page.goto(ordersPath(shopA, `?cursor=${encodeURIComponent(variants[name])}`));
    await expect(rowsOf(page), name).toHaveCount(20); // the page drops it: first page
    await expect.poll(() => api.matching('GET', /\/orders$/).map((entry) => entry.status), name).toEqual([200]);
  }
});

test('[orders.paging.cursor-after-new-orders] new slices arriving between page 1 and 2 do not shift page 2', async ({ page }) => {
  lines('orders.paging.cursor-after-new-orders');
  const shop = (await openSecondShop(owner)).shopId;
  seedSlices(shop, buyerId, Array.from({ length: 30 }, (_, index) => ({ createdAt: at(100 + index) })));
  const before = await readSlices(token, shop);
  await page.goto(ordersPath(shop));
  await expect(rowsOf(page)).toHaveCount(20);
  const nextHref = await page.getByRole('link', { name: 'Next page' }).getAttribute('href');
  // five new slices arrive (newer than everything) while the person is on page 1
  seedSlices(shop, buyerId, Array.from({ length: 5 }, (_, index) => ({ createdAt: at(-10 - index) })));
  await page.goto(nextHref ?? '');
  await expect(rowsOf(page)).toHaveCount(10);
  expect(await refsOf(page)).toEqual(before.slice(20).map((slice) => slice.shopOrderId.slice(0, 8)));
});

test('[orders.paging.cursor-same-timestamp] slices with the same createdAt are paged by id without loss', async ({ page }) => {
  lines('orders.paging.cursor-same-timestamp');
  const shop = (await openSecondShop(owner)).shopId;
  const same = at(500);
  const ids = Array.from({ length: 25 }, () => crypto.randomUUID()).sort().reverse();
  seedSlices(shop, buyerId, ids.map((id) => ({ id, createdAt: same })));
  const seen: string[] = [];
  await page.goto(ordersPath(shop));
  await expect(rowsOf(page)).toHaveCount(20);
  seen.push(...(await refsOf(page)));
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(rowsOf(page)).toHaveCount(5);
  seen.push(...(await refsOf(page)));
  expect(seen).toEqual(ids.map((id) => id.slice(0, 8)));
});

test('[orders.state.empty-page, orders.state.empty-filter] a cursor past the last row shows "No orders on this page." with First page (status kept)', async ({ page }) => {
  lines('orders.state.empty-page', 'orders.state.empty-filter');
  const shop = (await openSecondShop(owner)).shopId;
  seedSlices(shop, buyerId, Array.from({ length: 22 }, (_, index) => ({ createdAt: at(1000 + index) })));
  const cursor = (await sellerCall('GET', `/api/shops/${shop}/orders?limit=20`, undefined, token)).data.nextCursor as string;
  runSql(`delete from "BisOrder" where id in (select "bisOrderId" from "ShopOrder" where "shopId"='${shop}' and "createdAt" < '${at(1019)}')`);
  await page.goto(ordersPath(shop, `?status=PENDING&cursor=${encodeURIComponent(cursor)}`));
  await expect(page.getByText('No orders on this page.')).toBeVisible();
  await page.getByRole('link', { name: 'First page' }).click();
  await expect(page).toHaveURL(ordersPath(shop, '?status=PENDING'));
  await expect(rowsOf(page)).toHaveCount(20);
  await page.getByLabel('Status').selectOption('PAID');
  await expect(page.getByText('No orders match this status.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filter' }).or(page.getByRole('link', { name: 'Clear filter' })).click();
  await expect(page).toHaveURL(ordersPath(shop));
});

test('[orders.state.loading-first] with no server data the view shows the table skeleton: no spinner and no "Loading" text', async ({ page }) => {
  lines('orders.state.loading-first');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/shops/*/orders?*', async (route) => {
    await gate;
    await route.continue();
  });
  // a cursor the server refuses has no first read to seed the view; the browser's own read (held back) is the first data
  await page.goto(ordersPath(shopA, '?cursor=zzzz'), { waitUntil: 'commit' });
  const skeleton = page.locator('[data-skeleton="orders"]');
  await expect(skeleton).toBeVisible();
  expect(await skeleton.textContent()).toBe('');
  await expect(skeleton).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByText(/loading/i)).toHaveCount(0);
  await expect(page.locator('[role="progressbar"], .animate-spin')).toHaveCount(0);
  release();
  await expect(page.getByText('That page link is no longer valid.')).toBeVisible();
  await expect(skeleton).toHaveCount(0);
});

test('[orders.db.read-only] opening, filtering and paging write nothing', async ({ page }) => {
  lines('orders.db.read-only');
  const snapshot = () => runSql(`select (select count(*) from "ShopOrder" where "shopId"='${shopA}'), (select count(*) from "BisOrderItem" where "shopId"='${shopA}'), (select count(*) from "BisOrder" where id in (select "bisOrderId" from "ShopOrder" where "shopId"='${shopA}')), (select md5(string_agg(so."updatedAt"::text || o."updatedAt"::text, ',' order by so.id)) from "ShopOrder" so join "BisOrder" o on o.id=so."bisOrderId" where so."shopId"='${shopA}')`);
  const before = snapshot();
  const api = watchApi(page);
  await page.goto(ordersPath(shopA));
  await expect(rowsOf(page)).toHaveCount(20);
  await page.getByLabel('Status').selectOption('PAID');
  await expect(page).toHaveURL(/status=PAID$/);
  await expect(page.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', /status=PAID/);
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(rowsOf(page)).toHaveCount(2);
  expect(api.writes()).toEqual([]);
  expect(snapshot()).toBe(before);
});
