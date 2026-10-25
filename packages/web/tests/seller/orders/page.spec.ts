import { expect, test, type Page } from '@playwright/test';
import { UNKNOWN_ID, watchApi } from '../cross-cutting/support';
import { shopPath, sellerCall, SEED } from '../../helpers';
import { readSlices, shopWithOrders, signIn, type Fixture } from './support';

/**
 * AI QA, orders area, section "page": the address, the sign-in guard, the not-found page, the heading, the first read and the
 * skeleton (map: scripts/aiqa/coverage/orders.tsv). The lines are in each title and in the `aiqa-lines` annotation.
 */

test.setTimeout(240_000);

let fx: Fixture;

test.beforeAll(async ({ browser }) => {
  fx = await shopWithOrders(browser, { pending: 2, paid: 1 });
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
  await page.getByRole('button', { name: 'Open menu' }).last().click();
  await page.getByRole('dialog').getByRole('link', { name: 'Orders', exact: true }).click();
}

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, fx.owner);
  });

  test('[orders.page.route-and-nav, orders.page.heading, orders.page.server-first-read, orders.page.refetch-on-mount, orders.page.no-live-update] the sidebar entry opens the page, the first read is in the page and the browser asks again, once', async ({ page }) => {
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
    await expect(rowsOf(page)).toHaveCount(6);
    // the browser asks again on mount: one read of the list, answered 200
    await expect.poll(() => api.matching('GET', /\/orders$/).map((entry) => entry.status + ' ' + entry.path)).toEqual(['200 /api/shops/' + fx.shopId + '/orders']);
    // the address typed by hand carries the first read inside the page itself (hydration data), before any browser call
    const html = await (await page.request.get(ordersPath())).text();
    expect(html).toContain(first.shopOrderId);
    // no live channel for orders: no socket, and the shell's stream carries the person's topic, not the shop's live topic
    expect(sockets).toEqual([]);
    expect(streams.filter((url) => url.includes(`shop:${fx.shopId}`))).toEqual([]);
  });

  test('[orders.page.route-and-nav] the phone drawer has the Orders entry too', async ({ page }) => {
    lines('orders.page.route-and-nav');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(shopPath(fx.shopId));
    await page.getByRole('button', { name: 'Open menu' }).last().click();
    await page.getByRole('dialog').getByRole('link', { name: 'Orders', exact: true }).click();
    await expect(page).toHaveURL(ordersPath());
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  });

  test('[orders.page.shop-not-found] a malformed, unknown or foreign shop is one and the same not-found page; the API says 404 shop_not_found', async ({ page, browser }) => {
    lines('orders.page.shop-not-found');
    const other = await shopWithOrders(browser, { pending: 0, paid: 0 });
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

  test('[orders.page.suspense-skeleton, orders.page.skeleton-shape] the list skeleton has no text and no spinner and is shaped like the orders page (one select, no action)', async ({ page }) => {
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
    await expect(rowsOf(page)).toHaveCount(6);
    const seen = await page.evaluate(() => (window as unknown as { __skeleton?: Record<string, unknown> }).__skeleton);
    expect(seen, 'the skeleton was on screen while the page loaded').toBeTruthy();
    expect(seen?.text).toBe('');
    // W04.AS-91: shaped like the page it stands for. The orders page has one select in its toolbar and no heading action.
    expect(seen?.toolbarBoxes).toBe(1);
    expect(seen?.headerBoxes).toBe(1);
  });

  test.fixme('[orders.page.permission-gate, orders.page.forbidden-overview-button] a member without orders.read sees the forbidden panel', async () => {
    lines('orders.page.permission-gate', 'orders.page.forbidden-overview-button');
    // Blocked: every shop role (OWNER, ADMIN, STAFF, VIEWER) holds orders.read and the stack has no custom roles, so no member
    // without the permission can be made through any screen or route; the server decides before the browser can be changed.
  });
});

test.describe('signed out', () => {
  test('[orders.page.session-guard] a visitor is sent to sign-in with the same path and query, and lands on the same orders view after signing in', async ({ page }) => {
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
