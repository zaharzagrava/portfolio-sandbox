import { expect, test, type Page, type Route } from '@playwright/test';
import { NEW_USER_PASSWORD, resetRateLimits, sellerCall, shopPath, uniqueEmail } from '../../helpers';
import { openSecondShop, ownerWithShop, watchApi, type Member } from '../cross-cutting/support';
import { setShopStatus, userId } from '../support/db';
import { signIn } from './support';
import { seedSlices } from './seed';

/**
 * AI QA, orders area (pass 2), section "problem states": what the orders area shows when the read fails, is refused, is slow,
 * is rate limited, comes back wrong, or the browser goes offline (map: scripts/aiqa/coverage/orders.tsv). The failing answers
 * are made in the browser (the page's own read is answered by the test); the real answers are covered by the other specs.
 */

test.setTimeout(240_000);

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

test('[orders.state.error-read, orders.state.error-try-again] a 500 is retried once, then shows the catalogue text, a reference with a copy button and Try again; Try again reads again', async ({ page }) => {
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

test('[orders.state.error-read] a 502 reads "We couldn\'t load this right now" and a lost network "Couldn\'t reach the server"', async ({ page }) => {
  lines('orders.state.error-read');
  await failingRead(page, (route) => problem(route, 502, { code: 'upstream_unavailable', requestId: 'req-aiqa-0002' }));
  await expect(alertOf(page)).toContainText("We couldn't load this right now. Try again in a moment.");
  await expect(alertOf(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.unroute(LIST);
  await page.route(LIST, (route) => route.abort('connectionrefused'));
  await page.getByLabel('Status').selectOption('PENDING');
  await expect(alertOf(page)).toContainText("Couldn't reach the server. Check your connection and try again.");
});

test('[orders.state.error-copy-reference] Copy reference copies the id; when the clipboard is blocked the id stays selectable', async ({ page, context }) => {
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

test('[orders.state.error-4xx-no-retry] a 403 or 404 is not retried; a 5xx is retried once', async ({ page }) => {
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

test('[orders.state.error-bad-body] an answer that breaks the contract is an error, shown whole or not at all, and not retried', async ({ page }) => {
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

test('[orders.state.session-ended] a 401 while on the page shows the polite "session ended" status once', async ({ page }) => {
  lines('orders.state.session-ended');
  let calls = 0;
  await failingRead(page, async (route) => {
    calls += 1;
    await problem(route, 401, { code: 'invalid_token', requestId: 'req-aiqa-401' });
  });
  await expect(page.getByRole('status').filter({ hasText: 'Your session ended. Sign in again to continue.' }).first()).toBeVisible();
  expect(calls).toBe(1);
});

test('[orders.state.rate-limited, orders.state.rate-limited-text] a 429 shows a countdown and no Try again; both texts agree and it ends at "You can try again now."', async ({ page }) => {
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

test('[orders.state.offline] going offline shows the polite banner; coming back asks for the orders once', async ({ page, context }) => {
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

test('[orders.state.shop-deleted-while-open] a shop removed while the page is open: the next read shows "We couldn\'t find that shop."', async ({ page }) => {
  lines('orders.state.shop-deleted-while-open');
  const shop = (await openSecondShop(owner)).shopId;
  seedSlices(shop, buyerId, [0, 1].map((index) => ({ status: index ? 'PAID' : 'PENDING', createdAt: at(index) })));
  await page.goto(ordersPath(shop));
  await expect(rowsOf(page)).toHaveCount(2);
  setShopStatus(shop, 'DELETED');
  await page.getByLabel('Status').selectOption('PAID');
  await expect(page.getByText("We couldn't find that shop.").first()).toBeVisible();
});

test('[orders.table.currency-invalid-crash] one row with a currency the browser rejects (ZZZZ) does not take the page down', async ({ page }) => {
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

test('[orders.table.date-invalid] a createdAt that does not parse shows "Unknown"', async ({ page }) => {
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
