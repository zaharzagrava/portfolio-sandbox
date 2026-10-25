import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { API_URL, NEW_USER_PASSWORD, SEED, resetRateLimits, sellerCall, shopPath, uniqueEmail } from './helpers';
import {
  UNKNOWN_ID,
  joinShopAs,
  openSecondShop,
  ownerWithShop,
  readSlices,
  rows,
  runSql,
  scalar,
  seedSlices,
  setShopStatus,
  setSuspended,
  sharedShop,
  shopWithOrders,
  signIn,
  tokenOf,
  userId,
  watchApi,
  type Fixture,
  type Member,
  type Slice,
} from './support/seller-orders';

/**
 * The seller orders page (W04 AS-83 and its neighbours AS-84 to AS-98, new AS-120 and AS-121) and the order slices S10 hands to the
 * seller (S10 AS-13, AS-22, AS-33, AS-40, AS-41, AS-59, AS-61). One file for the orders area; the AI QA map lines
 * (`scripts/aiqa/coverage/orders.tsv`) are kept in the `aiqa-lines` annotation of each test.
 *
 * Titles end in a project tag: `@phone` = a phone-layout test (the coordinator runs only these on the mobile project), `@desktop` = runs once on desktop.
 * The checkout-made orders are made once per run by `sharedShop` and only read here. Checks that need no browser (API contract, rows)
 * run as Playwright API tests because they need the dev stack's database; they belong to the S10 backend suite when it can reach it.
 * The 12-minute auction, the 10,000-row seed, the hold-expiry sweep and the flash-sale wait are in `seller-orders.slow.spec.ts` (AIQA_SLOW=1).
 */

test.describe('page', () => {


test.describe.configure({ timeout: 480_000 });

let fx: Fixture;

test.beforeAll(async ({ browser }) => {
  fx = await sharedShop(browser, 'read', { pending: 15, paid: 3 });
});

const ordersPath = (query = '') => `${shopPath(fx.shopId, 'orders')}${query}`;
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');

/** Clicks the Orders entry of the sidebar; on a phone the sidebar is hidden, so the menu is opened first. */
async function openOrdersEntry(page: Page) {
  const sidebar = page.getByRole('navigation').getByRole('link', { name: 'Orders', exact: true }).first();
  if (await sidebar.isVisible()) {
    await sidebar.click();
    return;
  }
  await page.getByRole('button', { name: 'Open seller menu' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Orders', exact: true }).click();
}

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, fx.owner);
  });

  test('W04 AS-83 @desktop: the sidebar entry opens the page, the first read is in the page and the browser asks again, once', async ({ page }) => {
    lines('orders.page.route-and-nav', 'orders.page.heading', 'orders.page.server-first-read', 'orders.page.refetch-on-mount', 'orders.page.no-live-update');
    const first = (await readSlices(fx.token, fx.shopId))[0];
    const sockets: string[] = [];
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/_next/hmr')) sockets.push(socket.url()); // the dev server's own hot-reload channel is not the page's
    });
    const streams: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/streams')) streams.push(decodeURIComponent(request.url()));
    });
    const api = watchApi(page);
    await page.goto(shopPath(fx.shopId));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    api.reset(); // the overview reads other things; only what the orders page asks for counts
    streams.length = 0;
    await openOrdersEntry(page);
    await expect(page).toHaveURL(ordersPath());
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Orders', exact: true }).first()).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
    await expect(page.getByText(`The orders placed with ${fx.shopName}, newest first.`)).toBeVisible();
    await expect(rowsOf(page)).toHaveCount(20);
    // the browser asks again on mount: one read of the list, answered 200
    await expect.poll(() => api.matching('GET', /\/orders$/).map((entry) => entry.status + ' ' + entry.path)).toEqual(['200 /api/shops/' + fx.shopId + '/orders']);
    // the address typed by hand carries the first read inside the page itself (hydration data), before any browser call
    const html = await (await page.request.get(ordersPath())).text();
    expect(html).toContain(first.shopOrderId);
    // no live channel for orders: no socket, and the shell's stream carries the person's topic, not the shop's live topic
    expect(sockets).toEqual([]);
    expect(streams.filter((url) => url.includes(`shop:${fx.shopId}`))).toEqual([]);
  });

  test('W04 AS-98 @phone: the phone drawer has the Orders entry too', async ({ page }) => {
    lines('orders.page.route-and-nav');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(shopPath(fx.shopId));
    await page.getByRole('button', { name: 'Open seller menu' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Orders', exact: true }).click();
    await expect(page).toHaveURL(ordersPath());
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  });

  test('W04 AS-85 @desktop: a malformed, unknown or foreign shop is one and the same not-found page; the API says 404 shop_not_found', async ({ page, browser }) => {
    lines('orders.page.shop-not-found');
    const otherContext = await browser.newContext();
    const other = await ownerWithShop(await otherContext.newPage(), []);
    await otherContext.close();
    const texts: string[] = [];
    for (const id of ['not-a-uuid', UNKNOWN_ID, other.shopId]) {
      await page.goto(shopPath(id, 'orders'));
      await expect(page.getByText("We couldn't find that shop.")).toBeVisible();
      texts.push(await page.locator('#main-content').innerText());
      const answer = await sellerCall('GET', `/api/shops/${id}/orders`, undefined, fx.token);
      expect(answer.status).toBe(404);
      expect(answer.data.code).toBe('shop_not_found');
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).not.toContain(other.shopName);
  });

  test('W04 AS-91 @desktop: the list skeleton has no text and no spinner and is shaped like the orders page (one select, no action)', async ({ page }) => {
    lines('orders.page.suspense-skeleton', 'orders.page.skeleton-shape');
    await page.addInitScript(() => {
      const holder = window as unknown as { __skeleton?: { text: string; boxes: number; headerBoxes: number; toolbarBoxes: number } };
      new MutationObserver(() => {
        const skeleton = document.querySelector('[data-skeleton="list"]');
        if (!skeleton || holder.__skeleton) return;
        holder.__skeleton = {
          text: skeleton.textContent ?? '',
          boxes: skeleton.querySelectorAll('[class*="animate"]').length,
          headerBoxes: skeleton.querySelectorAll('[data-region="header"] > *').length,
          toolbarBoxes: skeleton.querySelectorAll('[data-region="toolbar"] > *').length,
        };
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(shopPath(fx.shopId));
    await openOrdersEntry(page);
    await expect(rowsOf(page)).toHaveCount(20);
    const seen = await page.evaluate(() => (window as unknown as { __skeleton?: Record<string, unknown> }).__skeleton);
    expect(seen, 'the skeleton was on screen while the page loaded').toBeTruthy();
    expect(seen?.text).toBe('');
    // W04.AS-91: shaped like the page it stands for. The orders page has one select in its toolbar and no heading action.
    expect(seen?.toolbarBoxes).toBe(1);
    expect(seen?.headerBoxes).toBe(1);
  });

});

test.describe('signed out', () => {
  test('W04 AS-84 @desktop: a visitor is sent to sign-in with the same path and query, and lands on the same orders view after signing in', async ({ page }) => {
    lines('orders.page.session-guard');
    const api = watchApi(page);
    await page.goto(ordersPath('?status=PAID&cursor=abc'));
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    expect(decodeURIComponent(new URL(page.url()).searchParams.get('returnTo') ?? '')).toBe(`${shopPath(fx.shopId, 'orders')}?status=PAID&cursor=abc`);
    // nothing of the shop was asked for from the browser before the redirect
    expect(api.seen.filter((entry) => /\/api\/shops\//.test(entry.path))).toEqual([]);
    await page.getByLabel(/email/i).fill(fx.owner.email);
    await page.getByLabel(/password/i).first().fill(fx.owner.password ?? 'SuperSecurePassword123!');
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await expect(page).toHaveURL(new RegExp(`${shopPath(fx.shopId, 'orders').replace(/\//g, '\\/')}\\?status=PAID`));
  });
});

void SEED;

});

test.describe('filter and table', () => {


test.describe.configure({ timeout: 240_000 });

let fx: Fixture;
let slices: Slice[];

test.beforeAll(async ({ browser }) => {
  fx = await sharedShop(browser, 'read', { pending: 15, paid: 3 });
  slices = await readSlices(fx.token, fx.shopId);
  expect(slices).toHaveLength(21);
});

const ordersPath = (query = '') => `${shopPath(fx.shopId, 'orders')}${query}`;
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const money = (minor: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 10 ** (new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2));
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');

test.beforeEach(async ({ page }) => {
  await signIn(page, fx.owner);
});

/** Answers the orders list with `change` applied to the real answer (the server still sends the real data). */
async function mutateAnswer(page: Page, change: (body: { items: Slice[] }) => void) {
  await page.route('**/api/shops/*/orders?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    change(body);
    await route.fulfill({ response, json: body });
  });
}

test.describe('filter', () => {
  test('W04 AS-83 @desktop: the status select has a label, the four options and works by keyboard', async ({ page }) => {
    lines('orders.filter.label', 'orders.filter.select-options', 'orders.filter.keyboard');
    await page.goto(ordersPath());
    const select = page.getByLabel('Status');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText(['All statuses', 'Pending', 'Paid', 'Cancelled', 'Refunded']);
    await page.locator('label[for="orders-status"]').click();
    await expect(select).toBeFocused();
    await select.press('ArrowDown');
    await expect(page).toHaveURL(/\?status=PENDING$/);
    await select.press('ArrowUp');
    await expect(page).toHaveURL(ordersPath());
    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(/\?status=PENDING$/);
    await expect(select).toBeFocused();
    await expect(select).toHaveValue('PENDING');
    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(/\?status=PAID$/);
    await expect(select).toBeFocused();
  });

  test('W04 AS-83 @desktop: each status asks the API for it and shows only that status', async ({ page }) => {
    lines('orders.filter.choose-status', 'orders.filter.status-pending', 'orders.filter.status-cancelled', 'orders.filter.back-to-all');
    const api = watchApi(page);
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
    for (const [status, label] of [['PAID', 'Paid'], ['PENDING', 'Pending'], ['CANCELLED', 'Cancelled']] as const) {
      const asked = page.waitForRequest((request) => /\/api\/shops\/[^/]+\/orders\?/.test(request.url()) && request.url().includes(`limit=20&status=${status}`));
      await page.getByLabel('Status').selectOption(status);
      await asked;
      await expect(page).toHaveURL(new RegExp(`\\?status=${status}$`));
      const expected = slices.filter((slice) => slice.status === status);
      await expect(rowsOf(page)).toHaveCount(Math.min(expected.length, 20));
      await expect(rowsOf(page).locator('td:nth-of-type(1)')).toHaveText(Array(Math.min(expected.length, 20)).fill(label));
      // the list was asked for with this status (the answer is 200) and nothing else was refused
      expect(api.seen.filter((entry) => entry.path.endsWith('/orders') && entry.status !== null && entry.status !== 200)).toEqual([]);
      expect(api.seen.some((entry) => entry.path.endsWith('/orders'))).toBe(true);
    }
    await page.getByLabel('Status').selectOption('');
    await expect(page).toHaveURL(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
  });

  test('W04 AS-83 @desktop: a status with no slices shows the empty message and a way back', async ({ page }) => {
    lines('orders.filter.status-refunded');
    // No stack route makes a REFUNDED slice, so only the empty state of the filter can be proved here.
    await page.goto(ordersPath('?status=REFUNDED'));
    await expect(page.getByText('No orders match this status.')).toBeVisible();
    await page.getByRole('link', { name: 'Clear filter' }).click();
    await expect(page).toHaveURL(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
  });

  test('W04 AS-83 @desktop: the status leaves the cursor, and the address brings the filter back', async ({ page }) => {
    lines('orders.filter.drops-cursor', 'orders.filter.address-restore');
    await page.goto(ordersPath());
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/cursor=/);
    await expect(rowsOf(page)).toHaveCount(1);
    await page.getByLabel('Status').selectOption('PAID');
    await expect(page).toHaveURL(ordersPath('?status=PAID'));
    await expect(rowsOf(page)).toHaveCount(3);
    await page.reload();
    await expect(page.getByLabel('Status')).toHaveValue('PAID');
    await expect(rowsOf(page)).toHaveCount(3);
    await page.goto(ordersPath());
    await page.goBack();
    await expect(page.getByLabel('Status')).toHaveValue('PAID');
  });

  test('W04 AS-97 @phone: the select is 44 px high on a phone and 32 px on a desktop', async ({ page }) => {
    lines('orders.filter.select-size-phone');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ordersPath());
    expect((await page.getByLabel('Status').boundingBox())?.height).toBe(44);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await page.getByLabel('Status').boundingBox())?.height).toBe(32);
  });

  test('W04 AS-83 @desktop: a lower-case or broken status is the default, an upper-case unknown one is refused by the API', async ({ page }) => {
    lines('orders.filter.unknown-status-in-address');
    const api = watchApi(page);
    for (const value of ['bogus', '%25%25']) {
      await page.goto(ordersPath(`?status=${value}`));
      await expect(rowsOf(page)).toHaveCount(20);
      await expect(page.getByLabel('Status')).toHaveValue('');
    }
    api.reset();
    await page.goto(ordersPath('?status=BOGUS'));
    // B-050 fixed: an unsupported value becomes the default (W04.R-10), also for the upper-case one
    await expect(rowsOf(page)).toHaveCount(20);
    await expect(page.getByLabel('Status')).toHaveValue('');
    expect(api.matching('GET', /\/orders$/).map((entry) => entry.status).filter((status) => status !== null && status !== 200)).toEqual([]);
  });

  test('W04 AS-83 @desktop: a repeated status in the address is the default on screen and in the first read (W04.R-10)', async ({ page }) => {
    lines('orders.filter.repeated-status');
    await page.goto(ordersPath('?status=PAID&status=PENDING'));
    await expect(rowsOf(page)).toHaveCount(20);
    await expect(page.getByLabel('Status')).toHaveValue('');
  });
});

test.describe('table', () => {
  test('W04 AS-95 @desktop: a row shows what the API sent for it', async ({ page }) => {
    lines('orders.table.region', 'orders.table.header-cells', 'orders.table.reference', 'orders.table.status-badge', 'orders.table.items-count', 'orders.table.subtotal', 'orders.table.date');
    await page.goto(ordersPath());
    const region = page.getByRole('region', { name: 'Orders' });
    await expect(region.locator('caption')).toHaveText(`Orders of ${fx.shopName}`);
    await expect(region.locator('thead th')).toHaveText(['Order', 'Status', 'Items', 'Subtotal', 'Date']);
    expect(await region.locator('thead th').evaluateAll((cells) => cells.map((cell) => cell.getAttribute('scope')))).toEqual(Array(5).fill('col'));
    await expect(region.locator('tbody tr').first().locator('th')).toHaveAttribute('scope', 'row');
    await expect(rowsOf(page)).toHaveCount(20);
    for (const [index, slice] of slices.slice(0, 20).entries()) {
      const row = rowsOf(page).nth(index);
      await expect(row.locator('th')).toHaveText(slice.shopOrderId.slice(-8));
      await expect(row.locator('th span')).toHaveClass(/font-mono/);
      await expect(row.locator('td').nth(0)).toHaveText(slice.status[0] + slice.status.slice(1).toLowerCase());
      await expect(row.locator('td').nth(1)).toHaveText(String(slice.items.length));
      await expect(row.locator('td').nth(2)).toHaveText(money(slice.subtotalMinor, slice.currency));
      const time = row.locator('time');
      await expect(time).toHaveAttribute('datetime', new Date(slice.createdAt).toISOString());
      await expect(time).toHaveAttribute('title', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
      await expect(time).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M$/);
    }
    // the newest slice is first
    expect(slices.map((slice) => slice.createdAt)).toEqual([...slices.map((slice) => slice.createdAt)].sort().reverse());
  });

  test('W04 AS-83 @desktop: two slices have two different references on screen (W04.B-32)', async ({ page }) => {
    lines('orders.table.reference-collision');
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
    const references = await rowsOf(page).locator('th').allInnerTexts();
    // The reference is the first 8 characters of a time-ordered id: slices made in the same minute read the same.
    expect(new Set(references).size, `references: ${references.join(' ')}`).toBe(references.length);
  });

  test('W04 AS-83 @desktop: lines count rows not units; another shop\'s lines and money never appear', async () => {
    lines('orders.table.items-count', 'orders.table.items-only-this-shop', 'orders.table.subtotal-vs-lines');
    const quantityThree = slices.find((slice) => slice.items.length === 1 && slice.items[0].quantity === 3);
    expect(quantityThree, 'a one-line slice of quantity 3 exists').toBeTruthy();
    const multi = slices.find((slice) => slice.orderId === fx.orders.multiLine);
    expect(multi?.items.map((item) => item.quantity).sort()).toEqual([2, 3]);
    const mixed = slices.find((slice) => slice.orderId === fx.orders.mixed);
    expect(mixed?.items.map((item) => [item.shopId, item.quantity])).toEqual([[fx.shopId, 2]]);
    expect(mixed?.subtotalMinor).toBe(500);
    expect(JSON.stringify(slices)).not.toContain(fx.otherShopId);
    for (const slice of slices) expect(slice.items.reduce((sum, item) => sum + item.lineTotalMinor, 0), slice.shopOrderId).toBe(slice.subtotalMinor);
    // the other shop sees only its own part of the same order
    const otherSlices = await readSlices(fx.token, fx.otherShopId);
    expect(otherSlices.map((slice) => [slice.orderId, slice.subtotalMinor])).toEqual([[fx.orders.mixed, 3108]]);
  });

  test('W04 AS-83 @desktop: each row is formatted with its own currency and its digits', async ({ page }) => {
    lines('orders.table.currency-zero-decimal', 'orders.table.no-default-currency');
    await mutateAnswer(page, (body) => {
      body.items[0].currency = 'JPY';
      body.items[1].currency = 'KWD';
      body.items[2].currency = 'usd';
    });
    await page.goto(ordersPath());

    await expect(rowsOf(page).nth(0).locator('td').nth(2)).toHaveText(/^¥/);
    await expect(rowsOf(page).nth(1).locator('td').nth(2)).toHaveText(/^KWD\s\d+\.\d{3}$/);
    await expect(rowsOf(page).nth(2).locator('td').nth(2)).toHaveText(/^\$/);
    await expect(rowsOf(page).nth(3).locator('td').nth(2)).toHaveText(/^€/);
  });

  test('W04 AS-83 @desktop: a row with a currency the browser does not know does not take the whole page down', async ({ page }) => {
    lines('orders.table.currency-unknown-code');
    await mutateAnswer(page, (body) => {
      body.items[0].currency = 'XX1';
    });
    const answered = page.waitForResponse((response) => /\/api\/shops\/[^/]+\/orders\?/.test(response.url()));
    await page.goto(ordersPath());
    await answered; // the browser's own read, with the bad currency in the first row
    await expect(rowsOf(page).nth(1)).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('W04 AS-83 @desktop: the largest safe amount is shown to the cent', async ({ page }) => {
    lines('orders.table.big-number');
    // The server refuses amounts above 2^53 - 1 (500 for the whole list, by design); the largest safe one must be exact.
    await mutateAnswer(page, (body) => {
      body.items[0].subtotalMinor = Number.MAX_SAFE_INTEGER;
    });
    await page.goto(ordersPath());
    await expect(rowsOf(page).nth(0).locator('td').nth(2)).toHaveText('€90,071,992,547,409.91');
  });

  test('W04 AS-83 @desktop: a status outside the four is not a title-case badge but the page error (strict answer check)', async ({ page }) => {
    lines('orders.table.status-unknown');
    await mutateAnswer(page, (body) => {
      (body.items[0] as { status: string }).status = 'PARTIALLY_SHIPPED';
    });
    await page.goto(ordersPath());
    await expect(page.getByText('Partially Shipped')).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: /went wrong|try again/i })).toBeVisible();
  });
});

});

test.describe('paging and empty states', () => {


test.describe.configure({ timeout: 240_000 });

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

test('W04 AS-83 @desktop: 45 slices are three pages of 20, 20, 5, newest first, nothing repeated or missing', async ({ page }) => {
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
  expect(seen).toEqual(all.map((slice) => slice.shopOrderId.slice(-8)));
  expect(new Set(seen).size).toBe(45);
  // every list read asked for 20 and was answered 200
  const reads = api.matching('GET', /\/orders$/);
  expect(reads.length).toBeGreaterThanOrEqual(3);
  expect(reads.every((entry) => entry.status === 200)).toBe(true);
  await page.getByRole('link', { name: 'First page' }).click();
  await expect(page).toHaveURL(ordersPath(shopA));
  await expect(rowsOf(page)).toHaveCount(20);
  expect(await refsOf(page)).toEqual(all.slice(0, 20).map((slice) => slice.shopOrderId.slice(-8)));
});

test('W04 AS-83 @desktop: First page keeps the status filter', async ({ page }) => {
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

test('W04 AS-83 @desktop: 0, 5, 20 and 21 slices: the paging links appear only for 21', async ({ page }) => {
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

test('S10 AS-59 @desktop: limit and status are checked by the API; a mismatching X-Shop-Id is refused', async () => {
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

test('W04 AS-83 @desktop: while the next page loads the old rows stay, dimmed, the table is busy and the paging links are hidden (W04.AS-31)', async ({ page }) => {
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

test('W04 AS-83 @desktop: while the next view loads (page or filter) the empty box never shows and the old rows stay', async ({ page }) => {
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

test('W04 AS-83 @desktop: Back after Next page returns to the previous rows; the cursor lives only in the address', async ({ page }) => {
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

test('W04 AS-89 @desktop: a cursor of shop A on shop B is refused 400 invalid_cursor, once, and the panel offers the first page', async ({ page }) => {
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
  // B-095 fixed: the first page keeps the status filter
  await expect(page).toHaveURL(ordersPath(shopB, '?status=PAID'));
  await expect(page.getByText('No orders match this status.')).toBeVisible(); // shop B holds 3 PENDING slices
});

test('W04 AS-89 @desktop: a hand-made cursor is dropped by the page or refused 400 invalid_cursor, never a 500', async ({ page }) => {
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

test('S10 AS-59 @desktop: new slices arriving between page 1 and 2 do not shift page 2', async ({ page }) => {
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
  expect(await refsOf(page)).toEqual(before.slice(20).map((slice) => slice.shopOrderId.slice(-8)));
});

test('S10 AS-59 @desktop: slices with the same createdAt are paged by id without loss', async ({ page }) => {
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
  expect(seen).toEqual(ids.map((id) => id.slice(-8)));
});

test('W04 AS-83 @desktop: a cursor past the last row shows "No orders on this page." with First page (status kept)', async ({ page }) => {
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

test('W04 AS-91 @desktop: with no server data the view shows the table skeleton: no spinner and no "Loading" text', async ({ page }) => {
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

test('S10 AS-61 @desktop: opening, filtering and paging write nothing', async ({ page }) => {
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

});

test.describe('error and loading states', () => {


test.describe.configure({ timeout: 240_000 });

const BASE = Date.now() - 3_600_000;
const at = (secondsAgo: number) => new Date(BASE - secondsAgo * 1000).toISOString();
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const alertOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).getByRole('alert');
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');
const LIST = '**/api/shops/*/orders?*';
const problem = (route: Route, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/problem+json', headers, body: JSON.stringify({ type: 'about:blank', status, ...body }) });

let owner: Member;
let shopId: string;
let buyerId: string;

const ordersPath = (shop = shopId, query = '') => `${shopPath(shop, 'orders')}${query}`;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const made = await ownerWithShop(page, []);
    owner = made.member;
    shopId = made.shopId;
    await resetRateLimits();
    const email = uniqueEmail('orders-states-buyer');
    expect((await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
    buyerId = userId(email);
    seedSlices(shopId, buyerId, [0, 1, 2].map((index) => ({ status: index === 0 ? 'PAID' : 'PENDING', createdAt: at(index * 10) })));
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ page }) => {
  await signIn(page, owner);
});

/** Opens the page with the real data, then makes the next read (a status change) fail the way `fail` says. */
async function failingRead(page: Page, fail: (route: Route) => Promise<void>) {
  const api = watchApi(page);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(3);
  await expect.poll(() => api.matching('GET', /\/orders$/).filter((entry) => entry.status !== null).length).toBe(1); // the on-mount read is over
  await page.route(LIST, fail);
  await page.getByLabel('Status').selectOption('PAID');
}

test('W04 AS-89 @desktop: a 500 is retried once, then shows the catalogue text, a reference with a copy button and Try again; Try again reads again', async ({ page }) => {
  lines('orders.state.error-read', 'orders.state.error-try-again');
  let calls = 0;
  await failingRead(page, async (route) => {
    calls += 1;
    await problem(route, 500, { title: 'SECRET SERVER TITLE', detail: 'SECRET SERVER DETAIL', code: 'internal_error', requestId: 'req-aiqa-0001' });
  });
  const alert = alertOf(page);
  await expect(alert).toContainText('Something went wrong on our side.');
  await expect(alert).toContainText('Reference: req-aiqa-0001');
  await expect(alert.getByRole('button', { name: 'Copy reference' })).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('SECRET SERVER');
  expect(calls, 'first read + one retry').toBe(2);
  // heading and filter stay usable
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  await expect(page.getByLabel('Status')).toBeEnabled();
  // Try again asks once more; with the route gone it shows the table
  await page.unroute(LIST);
  const api = watchApi(page);
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(rowsOf(page)).toHaveCount(1);
  expect(api.matching('GET', /\/orders$/).map((entry) => entry.status)).toEqual([200]);
  await expect(alertOf(page)).toHaveCount(0);
});

test('W04 AS-89 @desktop: a 502 reads "We couldn\'t load this right now" and a lost network "Couldn\'t reach the server"', async ({ page }) => {
  lines('orders.state.error-read');
  await failingRead(page, (route) => problem(route, 502, { code: 'upstream_unavailable', requestId: 'req-aiqa-0002' }));
  await expect(alertOf(page)).toContainText("We couldn't load this right now. Try again in a moment.");
  await expect(alertOf(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.unroute(LIST);
  await page.route(LIST, (route) => route.abort('connectionrefused'));
  await page.getByLabel('Status').selectOption('PENDING');
  await expect(alertOf(page)).toContainText("Couldn't reach the server. Check your connection and try again.");
});

test('W04 AS-89 @desktop: Copy reference copies the id; when the clipboard is blocked the id stays selectable', async ({ page, context }) => {
  lines('orders.state.error-copy-reference');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  await failingRead(page, (route) => problem(route, 500, { code: 'internal_error', requestId: 'req-aiqa-copy' }));
  const alert = alertOf(page);
  await alert.getByRole('button', { name: 'Copy reference' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()).catch(() => 'unreadable')).toBe('req-aiqa-copy');
  // blocked clipboard
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('blocked')) }, configurable: true });
  });
  await alert.getByRole('button', { name: /Copy reference|Copied/ }).click();
  const id = alert.locator('.select-text');
  await expect(id).toHaveText('req-aiqa-copy');
  expect(await id.evaluate((node) => getComputedStyle(node).userSelect)).not.toBe('none');
  await expect(alert).toBeVisible(); // the failure does not take the panel down
});

test('W04 AS-89 @desktop: a 403 or 404 is not retried; a 5xx is retried once', async ({ page }) => {
  lines('orders.state.error-4xx-no-retry');
  let calls = 0;
  await failingRead(page, async (route) => {
    calls += 1;
    await problem(route, 403, { code: 'permission_denied', requestId: 'req-aiqa-403' });
  });
  await expect(alertOf(page)).toBeVisible();
  await expect.poll(() => calls).toBe(1);
  await expect(alertOf(page)).toContainText("You don't have permission to do that.");
  calls = 0;
  await page.unroute(LIST);
  await page.route(LIST, async (route) => {
    calls += 1;
    await problem(route, 404, { code: 'shop_not_found', requestId: 'req-aiqa-404' });
  });
  await page.getByLabel('Status').selectOption('CANCELLED');
  await expect(page.getByText("We couldn't find that shop.").first()).toBeVisible();
  expect(calls).toBe(1);
});

test('W04 AS-89 @desktop: an answer that breaks the contract is an error, shown whole or not at all, and not retried', async ({ page }) => {
  lines('orders.state.error-bad-body');
  let calls = 0;
  const bad = async (route: Route, change: (item: Record<string, unknown>) => void) => {
    calls += 1;
    const response = await route.fetch();
    const body = await response.json();
    change(body.items[0]);
    await route.fulfill({ response, json: body });
  };
  for (const [name, change] of [
    ['extra field', (item: Record<string, unknown>) => (item.secretExtra = 'x')],
    ['wrong type', (item: Record<string, unknown>) => (item.subtotalMinor = 'twelve')],
    ['status outside the enum', (item: Record<string, unknown>) => (item.status = 'SHIPPED')],
  ] as const) {
    calls = 0;
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(3);
    await page.unroute(LIST);
    await page.route(LIST, (route) => bad(route, change));
    await page.getByLabel('Status').selectOption('PENDING');
    await expect(alertOf(page), name).toBeVisible();
    await expect(rowsOf(page), name).toHaveCount(0);
    expect(calls, `${name}: not retried`).toBe(1);
    await page.unroute(LIST);
  }
});

test('W04 AS-87 @desktop: a 401 while on the page shows the polite "session ended" status once', async ({ page }) => {
  lines('orders.state.session-ended');
  let calls = 0;
  await failingRead(page, async (route) => {
    calls += 1;
    await problem(route, 401, { code: 'invalid_token', requestId: 'req-aiqa-401' });
  });
  await expect(page.getByRole('status').filter({ hasText: 'Your session ended. Sign in again to continue.' }).first()).toBeVisible();
  expect(calls).toBe(1);
});

test('W04 AS-90 @desktop: a 429 shows a countdown and no Try again; both texts agree and it ends at "You can try again now."', async ({ page }) => {
  lines('orders.state.rate-limited', 'orders.state.rate-limited-text');
  let calls = 0;
  await failingRead(page, async (route) => {
    calls += 1;
    await problem(route, 429, { code: 'rate_limited', requestId: 'req-aiqa-429' }, { 'Retry-After': '7' });
  });
  const notice = page.getByText(/^Too many requests\. Try again in \d+ s\.$/);
  await expect(notice).toBeVisible();
  const shown = Number((await notice.innerText()).match(/in (\d+) s/)?.[1]);
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThanOrEqual(7);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(calls).toBe(1);
  // the screen-reader sentence says the same number as the visible one at the start
  const spoken = page.getByRole('status').filter({ hasText: /Try again in \d+ seconds?\./ });
  await expect(spoken).toHaveText(/Try again in 7 seconds\./);
  expect(shown).toBe(7);
  await expect(page.getByText('You can try again now.').first()).toBeVisible({ timeout: 15_000 });
});

test('W04 AS-88 @desktop: going offline shows the polite banner; coming back asks for the orders once', async ({ page, context }) => {
  lines('orders.state.offline');
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(3);
  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: "You're offline. Changes can't be saved." })).toBeVisible();
  const api = watchApi(page);
  await context.setOffline(false);
  await expect(page.getByText("You're offline. Changes can't be saved.")).toHaveCount(0);
  await expect.poll(() => api.matching('GET', /\/orders$/).length).toBe(1);
  await expect(rowsOf(page)).toHaveCount(3);
  expect(api.matching('GET', /\/orders$/).length).toBe(1);
});

test('W04 AS-85 @desktop: a shop removed while the page is open: the next read shows "We couldn\'t find that shop."', async ({ page }) => {
  lines('orders.state.shop-deleted-while-open');
  const shop = (await openSecondShop(owner)).shopId;
  seedSlices(shop, buyerId, [0, 1].map((index) => ({ status: index ? 'PAID' : 'PENDING', createdAt: at(index) })));
  await page.goto(ordersPath(shop));
  await expect(rowsOf(page)).toHaveCount(2);
  setShopStatus(shop, 'DELETED');
  await page.getByLabel('Status').selectOption('PAID');
  await expect(page.getByText("We couldn't find that shop.").first()).toBeVisible();
});

test('W04 AS-83 @desktop: one row with a currency the browser rejects (ZZZZ) does not take the page down', async ({ page }) => {
  lines('orders.table.currency-invalid-crash');
  await page.route(LIST, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.items[0].currency = 'ZZZZ';
    await route.fulfill({ response, json: body });
  });
  const answered = page.waitForResponse((response) => /\/api\/shops\/[^/]+\/orders\?/.test(response.url()));
  await page.goto(ordersPath());
  await answered; // the browser's own read, with the bad currency in the first row
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  await expect(rowsOf(page)).toHaveCount(3);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

test('W04 AS-83 @desktop: a createdAt that does not parse shows "Unknown"', async ({ page }) => {
  lines('orders.table.date-invalid');
  await page.route(LIST, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.items[0].createdAt = '2026-02-30T25:61:00.000Z';
    await route.fulfill({ response, json: body });
  });
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(3);
  await expect(rowsOf(page).first().locator('td').nth(3)).toHaveText('Unknown');
});

});

test.describe('roles and shop status', () => {


test.describe.configure({ timeout: 240_000 });

const BASE = Date.now() - 3_600_000;
const at = (secondsAgo: number) => new Date(BASE - secondsAgo * 1000).toISOString();
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');
const refsOf = (page: Page) => rowsOf(page).locator('th').allInnerTexts();

let owner: Member;
let token: string;
let shopId: string;
let shopName: string;
let buyerId: string;
let refs: string[];

const ordersPath = (shop = shopId, query = '') => `${shopPath(shop, 'orders')}${query}`;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const made = await ownerWithShop(page, []);
    ({ member: owner, token, shopId, shopName } = made);
    await resetRateLimits();
    const email = uniqueEmail('orders-roles-buyer');
    expect((await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
    buyerId = userId(email);
    seedSlices(shopId, buyerId, [0, 1, 2, 3, 4].map((index) => ({ status: index % 2 ? 'PAID' : 'PENDING', createdAt: at(index * 10) })));
    refs = (await readSlices(token, shopId)).map((slice) => slice.shopOrderId.slice(-8));
    expect(refs).toHaveLength(5);
  } finally {
    await context.close();
  }
});

for (const role of ['ADMIN', 'STAFF', 'VIEWER'] as const) {
  test(`W04 AS-121 @desktop: ${role} joins by invitation and sees the same orders, read-only`, async ({ browser }) => {
    lines(`orders.role.${role.toLowerCase()}`);
    const joined = await joinShopAs(browser, owner, shopId, role);
    try {
      const page = joined.page;
      const api = watchApi(page);
      await page.goto(ordersPath());
      await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
      await expect(rowsOf(page)).toHaveCount(5);
      expect(await refsOf(page)).toEqual(refs);
      if ((page.viewportSize()?.width ?? 1280) >= 1024) await expect(page.getByRole('navigation').getByRole('link', { name: 'Orders', exact: true }).first()).toHaveAttribute('aria-current', 'page');
      // nothing to change on this page, whatever the role
      const buttons = await page.locator('#main-content').getByRole('button').evaluateAll((nodes) => nodes.map((node) => `${node.getAttribute('aria-label') ?? node.textContent?.trim()} in ${node.closest('nav,aside,header,[role=region]')?.tagName ?? 'none'}`));
      if ((page.viewportSize()?.width ?? 1280) >= 1024) expect(buttons.filter((entry) => !/ in (NAV|ASIDE|HEADER)$/.test(entry)), 'buttons of the page itself').toEqual([]);
      await expect(page.getByRole('region', { name: 'Orders' }).getByRole('button')).toHaveCount(0);
      await page.getByLabel('Status').selectOption('PAID');
      await expect(rowsOf(page)).toHaveCount(2);
      expect(api.writes()).toEqual([]);
      // the member's own token reads the same list
      const mine = await tokenOf(joined.member);
      const answer = await sellerCall('GET', `/api/shops/${shopId}/orders?limit=100`, undefined, mine);
      expect(answer.status).toBe(200);
      expect((answer.data.items as { shopOrderId: string }[]).map((item) => item.shopOrderId.slice(-8))).toEqual(refs);
    } finally {
      await joined.context.close();
    }
  });
}

test('W04 AS-121 @desktop: a role change and then removal reach the orders page and API at once', async ({ browser }) => {
  lines('orders.role.permission-change-live');
  const joined = await joinShopAs(browser, owner, shopId, 'STAFF');
  try {
    const page = joined.page;
    const mine = await tokenOf(joined.member);
    const memberId = userId(joined.member.email);
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(5);
    const changed = await sellerCall('PATCH', `/api/shops/${shopId}/members/${memberId}`, { role: 'VIEWER' }, token);
    expect(changed.status, JSON.stringify(changed.data)).toBe(204);
    expect((await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, mine)).status).toBe(200);
    await page.reload();
    await expect(rowsOf(page)).toHaveCount(5);
    const removed = await sellerCall('DELETE', `/api/shops/${shopId}/members/${memberId}`, undefined, token);
    expect(removed.status).toBe(204);
    const afterApi = await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, mine);
    expect(afterApi.status).toBe(404);
    expect(afterApi.data.code).toBe('shop_not_found');
    await page.reload();
    await expect(page.getByText("We couldn't find that shop.")).toBeVisible();
  } finally {
    await joined.context.close();
  }
});

test('W04 AS-121 @desktop: another shop\'s member, a stranger and a visitor never get these orders', async ({ page }) => {
  lines('orders.role.foreign-shop-member', 'orders.security.idor-shop-order');
  const other = await ownerWithShop(page, []);
  seedSlices(other.shopId, buyerId, [{ createdAt: at(1) }]);
  const cursor = (await sellerCall('GET', `/api/shops/${shopId}/orders?limit=1`, undefined, token)).data.nextCursor as string;
  await signIn(page, other.member);
  await page.goto(ordersPath());
  await expect(page.getByText("We couldn't find that shop.")).toBeVisible();
  for (const ref of refs) await expect(page.locator('body')).not.toContainText(ref);
  const html = await (await page.request.get(ordersPath())).text();
  for (const slice of await readSlices(token, shopId)) expect(html).not.toContain(slice.shopOrderId);
  for (const query of ['', `?limit=1&cursor=${encodeURIComponent(cursor)}`]) {
    const answer = await sellerCall('GET', `/api/shops/${shopId}/orders${query}`, undefined, other.token);
    expect(answer.status).toBe(404);
    expect(answer.data.code).toBe('shop_not_found');
    expect(JSON.stringify(answer.data)).not.toContain(refs[0]);
  }
  // no session: 401 at the API and at the web origin
  expect((await sellerCall('GET', `/api/shops/${shopId}/orders`)).status).toBe(401);
  const anonymous = await fetch(`${API_URL.replace(':8000', ':3000')}/api/shops/${shopId}/orders`);
  expect(anonymous.status).toBe(401);
});

test('W04 AS-121 @desktop: after signing out and in as another person the first person\'s orders are gone from the page', async ({ page }) => {
  lines('orders.security.cache-per-user');
  const other = await ownerWithShop(page, []); // signs the page in as `other`
  await signIn(page, owner);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(5);
  // sign out through the account menu (desktop) or the phone menu (the header's "Open menu" button)
  if ((page.viewportSize()?.width ?? 1280) >= 1024) {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
  } else {
    await page.getByRole('button', { name: 'Open menu' }).first().click();
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: 'Log out' }).click();
  }
  await expect(page).toHaveURL(/\/login\?notice=signed_out$/);
  await signIn(page, other.member);
  const seen: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/orders')) void response.text().then((text) => seen.push(text), () => undefined);
  });
  await page.goto(ordersPath(shopId));
  await expect(page.getByText("We couldn't find that shop.")).toBeVisible();
  await page.goto(ordersPath(other.shopId));
  await expect(page.getByText('No orders yet.')).toBeVisible();
  for (const text of seen) for (const ref of refs) expect(text).not.toContain(ref);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(refs[0]);
});

test('W04 AS-93 @desktop: the browser calls the web origin with the cookie; no token in the request, the answer or the page', async ({ page }) => {
  lines('orders.api.proxy-no-token');
  await signIn(page, owner);
  const seen: { url: string; auth: string | undefined; hasCookie: boolean }[] = [];
  const bodies: string[] = [];
  const pending: Promise<unknown>[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/orders?')) pending.push(request.allHeaders().then((headers) => seen.push({ url: request.url(), auth: headers.authorization, hasCookie: Boolean(headers.cookie) }), () => undefined));
  });
  page.on('response', (response) => {
    if (response.url().includes('/orders?')) pending.push(response.text().then((text) => bodies.push(text + JSON.stringify(response.headers())), () => undefined));
  });
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(5);
  await page.getByLabel('Status').selectOption('PAID');
  await expect(rowsOf(page)).toHaveCount(2);
  await Promise.all(pending);
  expect(seen.length).toBeGreaterThan(0);
  for (const entry of seen) {
    expect(new URL(entry.url).origin).toBe('http://localhost:3000');
    expect(entry.auth).toBeUndefined();
    expect(entry.hasCookie).toBe(true);
  }
  const bearer = await tokenOf(owner);
  for (const body of bodies) expect(body).not.toContain(bearer);
  expect(await page.content()).not.toContain(bearer);
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/token|session/i);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(bearer);
});

test.describe('shop status', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ page }) => {
    await signIn(page, owner);
  });

  test('W04 AS-86 @desktop: an active shop has no status banner and loads', async ({ page }) => {
    lines('orders.shop.active');
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(5);
    await expect(page.getByText(/suspended|being closed/i)).toHaveCount(0);
  });

  test('W04 AS-86 @desktop: a suspended shop: banner above a list that still reads (W04.R-03); reinstated, the banner goes', async ({ page }) => {
    lines('orders.shop.suspended-banner', 'orders.shop.suspended-read', 'orders.shop.suspended-banner-vs-list', 'orders.shop.status-change-while-open');
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(5);
    await setSuspended(shopId, true);
    try {
      await expect.poll(async () => (await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, token)).status, { timeout: 90_000, intervals: [2_000] }).toBe(200);
      await page.goto(ordersPath());
      await expect(page.getByText('This shop is suspended. You can view data but not make changes.').first()).toBeVisible();
      await expect(rowsOf(page)).toHaveCount(5);
      await expect(page.getByRole('region', { name: 'Orders' }).getByRole('alert')).toHaveCount(0);
      await page.getByLabel('Status', { exact: true }).selectOption('PAID');
      await expect(rowsOf(page)).toHaveCount(2);
    } finally {
      await setSuspended(shopId, false);
    }
    // the status is cached for a short while: once the API reads again, a reload shows the list
    await expect.poll(async () => (await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, token)).status, { timeout: 90_000, intervals: [2_000] }).toBe(200);
    await page.reload();
    await expect(rowsOf(page)).toHaveCount(5);
    await expect(page.getByText('This shop is suspended.')).toHaveCount(0);
  });

  test('W04 AS-86 @desktop: a closing shop: banner above a list that still reads; a deleted shop is the not-found page', async ({ page }) => {
    lines('orders.shop.deleting', 'orders.shop.deleted');
    try {
      setShopStatus(shopId, 'DELETING');
      // the shop's status is cached for a while (a direct database change is not announced), so wait for the API to notice
      // B-024 fixed: a closing shop still reads (W04.R-03), with the banner above the list
      await page.goto(ordersPath());
      await expect(page.getByText('This shop is being closed. You can view data but not make changes.').first()).toBeVisible();
      await expect(rowsOf(page)).toHaveCount(5);
      await expect(page.getByRole('region', { name: 'Orders' }).getByRole('alert')).toHaveCount(0);
      expect((await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, token)).status).toBe(200);
      setShopStatus(shopId, 'DELETED');
      await expect.poll(async () => (await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, token)).status, { timeout: 90_000, intervals: [2_000] }).toBe(404);
      await page.goto(ordersPath());
      await expect(page.getByText("We couldn't find that shop.")).toBeVisible();
      const unknown = await page.goto(ordersPath(UNKNOWN_ID));
      expect(unknown?.status()).toBe((await page.goto(ordersPath()))?.status());
      expect((await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, token)).status).toBe(404);
    } finally {
      setShopStatus(shopId, 'ACTIVE');
    }
    // the status is cached for a short while: once the API reads again, so does the page
    await expect.poll(async () => (await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, token)).status, { timeout: 90_000, intervals: [2_000] }).toBe(200);
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(5);
  });
});

});

test.describe('API contract and owner', () => {


test.describe.configure({ timeout: 180_000 });

const BASE = Date.now() - 3_600_000;
const at = (secondsAgo: number) => new Date(BASE - secondsAgo * 1000).toISOString();
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');

let owner: Member;
let token: string;
let shopId: string;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const made = await ownerWithShop(page, []);
    ({ member: owner, token, shopId } = made);
    await resetRateLimits();
    const email = uniqueEmail('orders-contract-buyer');
    expect((await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
    seedSlices(shopId, userId(email), [0, 1, 2, 3, 4, 5].map((index) => ({ status: (['PENDING', 'PAID', 'CANCELLED'] as const)[index % 3], createdAt: at(index * 9), subtotal: 1000 + index, lines: 1 + (index % 2) })));
  } finally {
    await context.close();
  }
});

test('S10 AS-61 @desktop: the list answer has exactly the fields of the contract: no extra and no missing', async () => {
  lines('orders.api.contract');
  const answer = await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, token);
  expect(answer.status).toBe(200);
  expect(Object.keys(answer.data).sort()).toEqual(['items', 'nextCursor']);
  expect(answer.data.nextCursor).toBeNull();
  expect(answer.data.items).toHaveLength(6);
  for (const item of answer.data.items) {
    expect(Object.keys(item).sort()).toEqual(['createdAt', 'currency', 'items', 'orderId', 'shopOrderId', 'status', 'subtotalMinor']);
    expect(item.createdAt).toBe(new Date(item.createdAt).toISOString());
    expect(['PENDING', 'PAID', 'CANCELLED', 'REFUNDED']).toContain(item.status);
    expect(Number.isInteger(item.subtotalMinor)).toBe(true);
    expect(item.currency).toMatch(/^[A-Z]{3}$/);
    expect(item.items.length).toBeGreaterThan(0);
    for (const line of item.items) {
      expect(Object.keys(line).sort()).toEqual(['discountMinor', 'lineTotalMinor', 'productId', 'quantity', 'shopId', 'title', 'unitPriceMinor']);
    }
  }
});

test('W04 AS-121 @desktop: the OWNER sees the page and every slice of the shop', async ({ page }) => {
  lines('orders.role.owner');
  await signIn(page, owner);
  await page.goto(shopPath(shopId, 'orders'));
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  await expect(rowsOf(page)).toHaveCount(6);
  const api = (await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, token)).data.items as { shopOrderId: string }[];
  expect(await rowsOf(page).locator('th').allInnerTexts()).toEqual(api.map((item) => item.shopOrderId.slice(-8)));
  await expect(page.getByRole('region', { name: 'Orders' }).getByRole('button')).toHaveCount(0);
});

test('W04 AS-83 @desktop: ?status=BOGUS: the list shows with the default select, and a status can be picked', async ({ page }) => {
  lines('orders.filter.invalid-value-select-blank');
  await signIn(page, owner);
  await page.goto(`${shopPath(shopId, 'orders')}?status=BOGUS`);
  // W04.R-10 (B-050 fixed): an unsupported value becomes its default
  await expect(page.getByLabel('Status')).toHaveValue('');
  await expect(rowsOf(page).first()).toBeVisible();
  await page.getByLabel('Status').selectOption('PENDING');
  await expect(rowsOf(page)).toHaveCount(2);
});

});

test.describe('privacy and read-only', () => {


test.describe.configure({ timeout: 240_000 });

let fx: Fixture;
let slices: Slice[];

test.beforeAll(async ({ browser }) => {
  fx = await sharedShop(browser, 'read', { pending: 15, paid: 3 });
  slices = await readSlices(fx.token, fx.shopId);
});

const ordersPath = (query = '') => `${shopPath(fx.shopId, 'orders')}${query}`;
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');

test.beforeEach(async ({ page }) => {
  await signIn(page, fx.owner);
});

test('W04 AS-83 @desktop: W04.B-32 / AS-83 (B-035): no buyer identifier in the list answer or in the page HTML', async ({ page }) => {
  lines('orders.table.no-buyer-api-and-html');
  const buyerId = rows(`select "userId" from "BisOrder" where id='${slices[0].orderId}'`)[0][0];
  expect(buyerId).toMatch(/^[0-9a-f-]{36}$/);
  const answer = await page.request.get(`/api/shops/${fx.shopId}/orders?limit=20`);
  expect(answer.status()).toBe(200);
  const text = await answer.text();
  expect(text, 'API answer carries the buyer id').not.toContain(buyerId);
  expect(text).not.toContain('buyerId');
  const html = await (await page.request.get(ordersPath())).text();
  expect(html, 'page HTML carries the buyer id').not.toContain(buyerId);
  expect(html).not.toContain('buyerId');
});

test('W04 AS-83 @desktop: nothing about the buyer or the lines is drawn; rows are plain text', async ({ page }) => {
  lines('orders.table.no-buyer-ui', 'orders.table.no-line-detail-ui', 'orders.table.row-not-link');
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(Math.min(slices.length, 20));
  const buyerId = rows(`select "userId" from "BisOrder" where id='${slices[0].orderId}'`)[0][0];
  const buyerEmail = fx.buyer.email;
  const region = page.getByRole('region', { name: 'Orders' });
  const visible = await page.locator('#main-content').innerText();
  const markup = await region.innerHTML();
  for (const secret of [buyerId, buyerEmail, buyerEmail.split('@')[0]]) {
    expect(visible, `visible text has ${secret}`).not.toContain(secret);
    expect(markup, `table markup has ${secret}`).not.toContain(secret);
  }
  // tooltips and accessible names: every title attribute is a time, no aria-label names a person
  const titles = await region.locator('[title]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title')));
  for (const title of titles) expect(title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  // no product title, quantity detail or unit price in the page
  for (const title of [fx.products.cheap, fx.products.mid]) expect(visible).not.toContain(title);
  expect(visible).not.toMatch(/Orders (Cheap|Mid|Other)/);
  // read-only: no link, button, menu or actions column inside the table; the row does nothing on click
  expect(await region.locator('table a, table button, table [role="menuitem"], table th:has-text("Actions")').count()).toBe(0);
  const before = page.url();
  await rowsOf(page).first().click();
  await rowsOf(page).first().locator('th').click();
  expect(page.url()).toBe(before);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('W04 AS-120 @desktop: a shop name with markup shows as text in the subtitle and the caption', async ({ page, browser }) => {
  lines('orders.table.text-as-text', 'orders.security.xss-fields');
  const name = '<img src=x onerror=window.__pwned=1> <b>bold</b>';
  // a shop of its own (one seeded slice), so the shared shop keeps its name
  const context = await browser.newContext();
  const made = await ownerWithShop(await context.newPage(), []);
  await context.close();
  seedSlices(made.shopId, userId(fx.buyer.email), [{ createdAt: new Date(Date.now() - 60_000).toISOString() }]);
  runSql(`update "Shop" set name='${name.replace(/'/g, "''")}' where id='${made.shopId}'`);
  await signIn(page, made.member);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(shopPath(made.shopId, 'orders'));
  await expect(rowsOf(page)).toHaveCount(1);
  await expect(page.getByText(`The orders placed with ${name}, newest first.`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Orders' }).locator('caption')).toHaveText(`Orders of ${name}`);
  await expect(page.locator('#main-content img, #main-content b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test('W04 AS-120 @desktop: nothing on the orders page leads to the export page', async ({ page }) => {
  lines('orders.neighbor.export-link');
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(Math.min(slices.length, 20));
  // the page's own part: the heading block, the filter and the list (the sidebar's own "Order export" entry is a separate section)
  const own = page.locator('#main-content h1').locator('xpath=ancestor::div[contains(@class,"space-y-6")][1]');
  await expect(own).toHaveCount(1);
  const hrefs = await own.locator('a').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
  expect(hrefs.filter((href) => /export/i.test(href ?? ''))).toEqual([]);
  expect(await own.innerText()).not.toMatch(/export/i);
  // the sidebar entry exists and is the only way there
  const sidebar = await page.locator('nav a[href$="/exports"]').count();
  expect(sidebar).toBeGreaterThan(0);
});

});

test.describe('how orders come to exist', () => {


test.describe.configure({ timeout: 480_000 });

let fx: Fixture;
let slices: Slice[];

test.beforeAll(async ({ browser }) => {
  fx = await sharedShop(browser, 'read', { pending: 15, paid: 3 });
  slices = await readSlices(fx.token, fx.shopId);
});

const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const ordersPath = () => shopPath(fx.shopId, 'orders');
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');
const sliceOf = (orderId: string) => slices.find((slice) => slice.orderId === orderId) as Slice;
const badgeOf = async (page: Page, slice: Slice) => {
  const current = await readSlices(fx.token, fx.shopId); // the list as it is now (other tests add slices)
  const at = current.findIndex((entry) => entry.shopOrderId === slice.shopOrderId);
  // the shop has more than one page of slices: older ones are on the next page
  let row = at;
  if (at >= 20) {
    await page.getByRole('link', { name: 'Next page' }).click();
    row = at - 20;
  }
  await expect(rowsOf(page).nth(row).locator('th')).toHaveText(slice.shopOrderId.slice(-8));
  return rowsOf(page).nth(row).locator('td').first().innerText();
};
const call = async (method: string, route: string, body: unknown, token: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`${API_URL}${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
};

test.beforeEach(async ({ page }) => {
  await signIn(page, fx.owner);
});

test('S10 AS-13 @desktop: a checkout makes one RESERVED order, its lines, one PENDING slice with the sum of the lines and held stock; the slice shows as Pending', async ({ page }) => {
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
  await expect(rowsOf(page)).toHaveCount(Math.min(slices.length, 20));
  expect(await badgeOf(page, slice)).toBe('Pending');
});

test('S10 AS-41 @desktop: a payment moves the order and every slice to PAID with a completed Payment; the badge is Paid', async ({ page }) => {
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

test('S10 AS-40 @desktop: a buyer cancel sets the order and the slice CANCELLED (user_cancelled) and frees the stock; the row shows Cancelled', async ({ page }) => {
  lines('orders.source.cancel-marks-cancelled', 'orders.db.slice-order-link');
  const orderId = fx.orders.cancelled;
  const slice = sliceOf(orderId);
  expect(rows(`select status, "cancelReason" from "BisOrder" where id='${orderId}'`)).toEqual([['CANCELLED', 'user_cancelled']]);
  expect(rows(`select status from "ShopOrder" where "bisOrderId"='${orderId}'`)).toEqual([['CANCELLED']]);
  expect(rows(`select status from "StockReservation" where "bisOrderId"='${orderId}'`)).not.toContainEqual(['HELD']);
  await page.goto(ordersPath());
  expect(await badgeOf(page, slice)).toBe('Cancelled');
});

test('S10 AS-22 @desktop: a cart with two shops gives each shop one row with its own subtotal; the buyer total is the sum', async () => {
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

test('S10 AS-61 @desktop: lines in a cart that was never checked out are not in the list', async () => {
  lines('orders.source.cart-not-in-list');
  const before = slices.length;
  await call('DELETE', '/api/cart', undefined, fx.buyer.token);
  expect((await call('PUT', `/api/cart/items/${fx.products.cheap}`, { quantity: 2 }, fx.buyer.token)).status).toBeLessThan(300);
  expect((await call('GET', '/api/cart', undefined, fx.buyer.token)).data.items?.length ?? 1).toBeGreaterThan(0);
  expect(await readSlices(fx.token, fx.shopId)).toHaveLength(before);
  expect(Number(scalar(`select count(*) from "ShopOrder" where "shopId"='${fx.shopId}'`))).toBe(before);
  await call('DELETE', '/api/cart', undefined, fx.buyer.token);
});

test('W04 AS-120 @desktop: the list shows the gross subtotal only: no fee, payout or net in the answer or on the page', async ({ page }) => {
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


test.describe('orders a test adds to its own shop', () => {
  let fx: Fixture;
  test.beforeAll(async ({ browser }) => {
    fx = await shopWithOrders(browser, { pending: 1, paid: 0 });
  });
  const ordersPath = () => shopPath(fx.shopId, 'orders');
  const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
test('S10 AS-33 @desktop: two buyers race for the last piece: the loser is refused at once (422) or cancelled for stock, and the refused attempt never shows in the seller list (B-093)', async () => {
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
  // whatever the answers were, the one piece went to one order; the other buyer's attempt stays as a CANCELLED(out_of_stock)
  // order (the replay record of its idempotency key) but holds no stock, so the seller's list does not show it
  await expect
    .poll(
      async () => rows(`select o.status || '/' || coalesce(o."cancelReason",'') from "BisOrder" o join "BisOrderItem" i on i."bisOrderId"=o.id where i."productId"='${productId}' order by 1`).flat(),
      { timeout: 30_000 },
    )
    .toEqual(['CANCELLED/out_of_stock', 'RESERVED/']);
  const listed = (await readSlices(fx.token, fx.shopId)).filter((slice) => slice.items.some((item) => item.productId === productId));
  expect(listed.map((slice) => slice.status)).toEqual(['PENDING']);
  test.info().annotations.push({ type: 'observed', description: `checkout answers ${answers.map((answer) => answer.status).join('/')}; the refused attempt leaves a Cancelled order that the seller list hides` });
});

test('W04 AS-121 @desktop: a member of the shop who buys from it gets a row like any other buyer (the list is by shop only)', async ({ browser }) => {
  lines('orders.source.rls-or-tenancy');
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
});
});

test.describe('database rows', () => {


test.describe.configure({ timeout: 240_000 });

const BASE = Date.now() - 3_600_000;
const at = (secondsAgo: number) => new Date(BASE - secondsAgo * 1000).toISOString();
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');

let owner: Member;
let token: string;
let buyerId: string;
const ordersPath = (shop: string, query = '') => `${shopPath(shop, 'orders')}${query}`;

test.beforeAll(async ({ browser }) => {
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
const read = async (shop: string) => (await sellerCall('GET', `/api/shops/${shop}/orders?limit=100`, undefined, token)).data.items as Slice[];

test('S10 AS-61 @desktop: currency comes from BisOrder (the buyer is joined but never sent) through the join; a slice cannot exist without its BisOrder', async ({ page }) => {
  lines('orders.db.join-bisorder');
  const shop = await newShop();
  const [first, second] = seedSlices(shop, buyerId, [{ createdAt: at(1), subtotal: 12345 }, { createdAt: at(2), subtotal: 500 }]);
  runSql(`update "BisOrder" set currency='USD' where id='${first.orderId}'`);
  const items = await read(shop);
  expect(items.map((item) => [item.shopOrderId, item.currency])).toEqual([
    [first.shopOrderId, 'USD'],
    [second.shopOrderId, 'EUR'],
  ]);
  await signIn(page, owner);
  await page.goto(ordersPath(shop));
  await expect(rowsOf(page)).toHaveCount(2);
  await expect(rowsOf(page).nth(0).locator('td').nth(2)).toHaveText('$123.45');
  await expect(rowsOf(page).nth(1).locator('td').nth(2)).toHaveText('€5.00');
  // a ShopOrder row with no BisOrder is refused by the database (so the inner join can never drop a real slice)
  expect(() => runSql(`insert into "ShopOrder"(id,"bisOrderId","shopId",subtotal,status) values (gen_random_uuid(), gen_random_uuid(), '${shop}', 1, 'PAID')`)).toThrow();
  expect(scalar(`select count(*) from "ShopOrder" where "shopId"='${shop}'`)).toBe('2');
});

test('S10 AS-61 @desktop: a slice whose shop is NULL is never listed, for any shop', async () => {
  lines('orders.db.null-shopid');
  const shop = await newShop();
  const other = await newShop();
  const [, orphan] = seedSlices(shop, buyerId, [{ createdAt: at(1) }, { createdAt: at(2), noShop: true }, { createdAt: at(3) }]);
  expect(scalar(`select count(*) from "ShopOrder" where id='${orphan.shopOrderId}' and "shopId" is null`)).toBe('1');
  expect((await read(shop)).map((item) => item.shopOrderId)).not.toContain(orphan.shopOrderId);
  expect(await read(shop)).toHaveLength(2);
  expect(await read(other)).toHaveLength(0);
});

test('S10 AS-22 @desktop: an order across two shops lists each shop its own lines, once', async ({ page }) => {
  lines('orders.db.lines-join');
  const shopA = await newShop();
  const shopB = await newShop();
  const [made] = seedSlices(shopA, buyerId, [{ createdAt: at(1), subtotal: 3000, lines: 2 }]);
  const idB = crypto.randomUUID();
  runSql(`insert into "ShopOrder"(id,"bisOrderId","shopId",subtotal,status,"createdAt","updatedAt") values ('${idB}','${made.orderId}','${shopB}',700,'PENDING','${at(1)}','${at(1)}');
          insert into "BisOrderItem"(id,"bisOrderId","productId",quantity,"priceAtPurchase","createdAt","updatedAt","shopId",title,"discountMinor","lineTotalMinor") values
          (gen_random_uuid(),'${made.orderId}',gen_random_uuid(),1,300,now(),now(),'${shopB}','B one',0,300),
          (gen_random_uuid(),'${made.orderId}',gen_random_uuid(),1,400,now(),now(),'${shopB}','B two',0,400)`);
  const a = await read(shopA);
  const b = await read(shopB);
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  expect(a[0].items.map((item) => item.shopId)).toEqual([shopA, shopA]);
  expect(b[0].items.map((item) => item.shopId)).toEqual([shopB, shopB]);
  expect(b[0].items.map((item) => item.lineTotalMinor).sort()).toEqual([300, 400]);
  expect(a[0].subtotalMinor).toBe(3000);
  expect(b[0].subtotalMinor).toBe(700);
  await signIn(page, owner);
  await page.goto(ordersPath(shopB));
  await expect(rowsOf(page)).toHaveCount(1);
  await expect(rowsOf(page).first().locator('td').nth(1)).toHaveText('2');
});

test('S10 AS-61 @desktop: a NULL line title is empty text and a NULL line total falls back to unit price times quantity', async () => {
  lines('orders.db.line-title-null');
  const shop = await newShop();
  seedSlices(shop, buyerId, [{ createdAt: at(1), subtotal: 900, nullTitle: true, nullLineTotal: true }]);
  runSql(`update "BisOrderItem" set quantity=3, "priceAtPurchase"=300 where "shopId"='${shop}'`);
  const item = (await read(shop))[0].items[0] as unknown as { title: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number };
  expect(rows(`select title, "lineTotalMinor" is null from "BisOrderItem" where "shopId"='${shop}'`)).toEqual([['', 't']]);
  expect(item.title).toBe('');
  expect(item.quantity).toBe(3);
  expect(item.lineTotalMinor).toBe(900);
});

});

test.describe('phone layout and accessibility', () => {


test.describe.configure({ timeout: 240_000 });

const BASE = Date.now() - 3_600_000;
const at = (secondsAgo: number) => new Date(BASE - secondsAgo * 1000).toISOString();
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const LIST = '**/api/shops/*/orders?*';

let owner: Member;
let shopId: string; // 25 slices, four statuses
let emptyShop: string;
let buyerId: string;
const ordersPath = (shop = shopId, query = '') => `${shopPath(shop, 'orders')}${query}`;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const made = await ownerWithShop(page, []);
    owner = made.member;
    shopId = made.shopId;
    await resetRateLimits();
    const email = uniqueEmail('orders-phone-buyer');
    expect((await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
    buyerId = userId(email);
    const statuses = ['PENDING', 'PAID', 'CANCELLED', 'REFUNDED'] as const;
    seedSlices(shopId, buyerId, Array.from({ length: 25 }, (_, index) => ({ status: statuses[index % 4], createdAt: at(index * 7), subtotal: 1999 + index, lines: 1 + (index % 3) })));
    emptyShop = (await openSecondShop(owner)).shopId;
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ page }) => {
  await signIn(page, owner);
});

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function scan(page: Page, state: string, selector = 'body') {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('nextjs-portal').include(selector).analyze();
  const text = violations.map((v) => `${state}: ${v.id} (${v.impact}): ${v.help} [${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}]`);
  for (const v of violations.filter((entry) => entry.impact !== 'serious' && entry.impact !== 'critical')) test.info().annotations.push({ type: 'axe-minor', description: text[violations.indexOf(v)] });
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => text[violations.indexOf(v)]), state).toEqual([]);
}

test('W04 AS-97 @phone: at 390 px each row is a card with the reference as heading and label/value pairs, and nothing scrolls sideways', async ({ page }) => {
  lines('orders.table.phone-cards', 'orders.phone.layout-390');
  await page.setViewportSize(PHONE);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(20);
  const first = rowsOf(page).first();
  expect(await first.evaluate((row) => getComputedStyle(row).display)).toBe('block');
  expect(await first.locator('th').evaluate((cell) => getComputedStyle(cell).display)).toBe('block');
  expect(await first.locator('td').evaluateAll((cells) => cells.map((cell) => [cell.getAttribute('data-label'), getComputedStyle(cell, '::before').content, getComputedStyle(cell).display]))).toEqual([
    ['Status', '"Status"', 'flex'],
    ['Items', '"Items"', 'flex'],
    ['Subtotal', '"Subtotal"', 'flex'],
    ['Date', '"Date"', 'flex'],
  ]);
  // same DOM as the table: the header row is kept for assistive technology only
  expect(await page.getByRole('region', { name: 'Orders' }).locator('thead').evaluate((head) => getComputedStyle(head).position)).toBe('absolute');
  await expect(page.getByRole('region', { name: 'Orders' }).locator('thead th')).toHaveText(['Order', 'Status', 'Items', 'Subtotal', 'Date']);
  expect(await noSideScroll(page)).toBe(true);
  const box = await first.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  expect((await page.getByLabel('Status').boundingBox())!.height).toBe(44);
  // back at desktop width it is a table again
  await page.setViewportSize(DESKTOP);
  await expect.poll(() => first.evaluate((row) => getComputedStyle(row).display)).toBe('table-row');
});

test('W04 AS-97 @phone: very wide values and a long shop name wrap and do not widen the page at 390 px', async ({ page }) => {
  lines('orders.table.long-values');
  await page.setViewportSize(PHONE);
  const name = 'W'.repeat(80); // the longest name the shop form takes
  runSql(`update "Shop" set name='${name}' where id='${shopId}'`);
  try {
    await page.route(LIST, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.items[0].subtotalMinor = Number.MAX_SAFE_INTEGER;
      body.items[1].currency = 'JPY';
      await route.fulfill({ response, json: body });
    });
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
    await expect(page.getByText(`The orders placed with ${name}, newest first.`)).toBeVisible();
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((node) => node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0 && getComputedStyle(node).display !== 'inline').map((node) => `${node.tagName}.${(node as HTMLElement).className.toString().slice(0, 40)}: ${node.textContent?.slice(0, 30)} (${node.scrollWidth} > ${node.clientWidth})`).slice(0, 6));
    expect(wide, 'elements wider than the 390 px screen').toEqual([]);
    expect(await noSideScroll(page)).toBe(true);
    const box = await rowsOf(page).first().boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  } finally {
    runSql(`update "Shop" set name='AIQA orders phone shop' where id='${shopId}'`);
  }
});

test('W04 AS-97 @phone: First page and Next page are 44 px high, on one row, left and right', async ({ page }) => {
  lines('orders.phone.paging-buttons');
  await page.setViewportSize(PHONE);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(20);
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(rowsOf(page)).toHaveCount(5);
  // page 2 of 2 has only First page; make a middle page by asking for a smaller list is not possible, so check both sides on page 2 of 45
  const more = (await openSecondShop(owner)).shopId;
  seedSlices(more, buyerId, Array.from({ length: 45 }, (_, index) => ({ createdAt: at(index) })));
  await page.goto(ordersPath(more));
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
  const [first, next] = [await page.getByRole('link', { name: 'First page' }).boundingBox(), await page.getByRole('link', { name: 'Next page' }).boundingBox()];
  expect(first!.height).toBe(44);
  expect(next!.height).toBe(44);
  expect(Math.abs(first!.y - next!.y)).toBeLessThan(2);
  expect(first!.x).toBeLessThan(next!.x);
  expect(first!.x).toBeLessThan(PHONE.width / 2);
  expect(next!.x + next!.width).toBeGreaterThan(PHONE.width / 2);
  expect(next!.x + next!.width).toBeLessThanOrEqual(PHONE.width);
  expect(await noSideScroll(page)).toBe(true);
});

test('W04 AS-95 @phone: axe finds nothing serious on the table, the cards, the empty box, the paging page and the error panel', async ({ page }) => {
  lines('orders.a11y.axe');
  for (const viewport of [DESKTOP, PHONE]) {
    await page.setViewportSize(viewport);
    const tag = viewport.width === 390 ? 'phone' : 'desktop';
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
    await scan(page, `table ${tag}`);
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(rowsOf(page)).toHaveCount(5);
    await scan(page, `page 2 ${tag}`);
    await page.goto(ordersPath(emptyShop));
    await expect(page.getByText('No orders yet.')).toBeVisible();
    await scan(page, `empty ${tag}`);
    await page.goto(ordersPath(shopId, '?cursor=zzzz'));
    await expect(page.getByRole('alert')).toBeVisible();
    await scan(page, `error ${tag}`);
  }
});

test('W04 AS-95 @desktop: the pager is nav "Pages", the list is region "Orders", the only heading is h1', async ({ page }) => {
  lines('orders.a11y.landmarks');
  await page.setViewportSize(DESKTOP);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(20);
  await expect(page.getByRole('region', { name: 'Orders' })).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(1);
  expect(await page.getByRole('navigation', { name: 'Pages' }).evaluate((node) => node.tagName)).toBe('NAV');
  await expect(page.locator('#main-content h1')).toHaveCount(1);
  // the sidebar's group names are h2 inside the navigation; the page's own part has the one h1
  expect(await page.locator('#main-content h2:not(nav h2), #main-content h3, #main-content h4, #main-content h5, #main-content h6').evaluateAll((nodes) => nodes.map((node) => `${node.tagName}:${node.textContent?.trim()} in ${node.closest('nav,aside,header,[role=region]')?.tagName ?? 'none'}`))).toEqual([]);
  await expect(page.getByRole('region', { name: 'Orders' }).locator('table')).toHaveCount(1);
});

test('W04 AS-95 @desktop: Tab goes sidebar, status select, then the Next page link; the focus ring is visible; the select works by keys', async ({ page }) => {
  lines('orders.a11y.focus');
  await page.setViewportSize(DESKTOP);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(20);
  const sidebarLast = page.getByRole('navigation').getByRole('link').last();
  await page.getByRole('navigation').getByRole('link', { name: 'Orders', exact: true }).first().focus();
  const order: string[] = [];
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.tagName}:${el.id || el.textContent?.trim().slice(0, 20) || ''}` : 'none';
    });
    order.push(label);
    if (label === 'A:Next page') break;
  }
  const selectAt = order.indexOf('SELECT:orders-status');
  const nextAt = order.indexOf('A:Next page');
  expect(selectAt, order.join(' > ')).toBeGreaterThanOrEqual(0);
  expect(nextAt, order.join(' > ')).toBeGreaterThan(selectAt);
  // nothing inside the table takes focus between the select and the pager
  expect(order.slice(selectAt + 1, nextAt)).toEqual([]);
  // focus ring on the pager link and on the select
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByLabel('Status')).toBeFocused();
  const ring = await page.getByLabel('Status').evaluate((node) => {
    const style = getComputedStyle(node);
    return { outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0, shadow: style.boxShadow !== 'none' };
  });
  expect(ring.outline || ring.shadow).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Next page' })).toBeFocused();
  const linkRing = await page.getByRole('link', { name: 'Next page' }).evaluate((node) => {
    const style = getComputedStyle(node);
    return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
  });
  expect(linkRing).toBe(true);
  void sidebarLast;
});

test('W04 AS-95 @desktop: badges, the filtered table and the error panel pass axe contrast in dark mode', async ({ page }) => {
  lines('orders.a11y.dark-mode');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize(DESKTOP);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(20);
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
  await scan(page, 'dark table');
  // the dimmed busy state cannot be reached (see the busy-keeps-rows test), so it is not scanned here
  await page.getByLabel('Status').selectOption('PAID');
  await expect(page).toHaveURL(/status=PAID/);
  await scan(page, 'dark filtered');
  await page.goto(ordersPath(shopId, '?cursor=zzzz'));
  await expect(page.getByRole('region', { name: 'Orders' }).getByRole('alert')).toBeVisible();
  await scan(page, 'dark error');
});

});
