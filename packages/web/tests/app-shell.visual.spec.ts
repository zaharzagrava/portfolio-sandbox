import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { register } from './helpers';

/**
 * Screenshot rows of specs/web/W07-app-shell/test-plan.md that the running app can reach. Taken at the two projects'
 * viewports (mobile 390 x 844, desktop 1280 x 800). Rows that need a failure the app cannot be made to show without a
 * test hook (error page, root-error page, access denied, 503, toasts) are listed in gaps.md "Not automated".
 */

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;
const header = (page: Page) => page.getByRole('banner');

// The dev server's indicator would otherwise be in every baseline.
const stylePath = path.join(__dirname, 'visual', 'hide-dev-overlay.css');
const shot = (target: Locator, name: string, options: Record<string, unknown> = {}) => expect(target).toHaveScreenshot(name, { stylePath, ...options });
const shotPage = (page: Page, name: string, options: Record<string, unknown> = {}) => expect(page).toHaveScreenshot(name, { stylePath, ...options });

/** A visitor, whatever the dev stack's cookies say: the session read answers `401`. */
async function stubSession(page: Page, member: null) {
  await page.route('**/api/bff/session', (route) => {
    if (route.request().method() !== 'GET' || member !== null) return route.fallback();
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'unauthenticated' }) });
  });
}

/**
 * A real member: registered and signed in through the UI, so the server and the browser agree about the session (a stub
 * that only the browser sees makes the server's markup and the first client render differ).
 */
async function becomeMember(page: Page, pathname = '/privacy') {
  await register(page);
  await page.goto(pathname);
  await expect(header(page).getByRole('button', { name: /Notifications/i })).toBeVisible({ timeout: 15_000 });
}

const docsFixture = {
  openapi: '3.1.0',
  info: { title: 'Marketplace seller API', version: '2026-10-01' },
  tags: [{ name: 'products', description: 'Create, read and list the products of your shop.' }, { name: 'stock' }],
  paths: {
    '/v1/products': {
      get: { operationId: 'listProducts', summary: 'List the products', tags: ['products'], 'x-required-scope': 'products:read', responses: { '200': { description: 'Success' } } },
      post: { operationId: 'createProduct', summary: 'Create a product', tags: ['products'], 'x-required-scope': 'products:write', responses: { '201': { description: 'Created' } } },
    },
    '/v1/stock/{productId}': {
      put: { operationId: 'setStock', summary: 'Set the stock of one product', tags: ['stock'], deprecated: true, 'x-sunset': '2027-04-01T00:00:00Z', 'x-replacement': '/v1/stock/bulk', responses: { '200': { description: 'Success' } } },
    },
  },
};

test.describe('W07 app shell layout', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`W07 AS-01 VN header, anonymous (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await stubSession(page, null);
      await page.goto('/privacy');
      await expect(header(page).getByRole('link', { name: 'Log in' })).toBeVisible();
      await shot(header(page), `header-anonymous-${scheme}.png`);
    });

    test(`W07 AS-01 VN header, member (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await becomeMember(page);
      // the unread badge depends on what the notification pipeline has delivered by now: not part of the layout
      await shot(header(page), `header-member-${scheme}.png`, { mask: [header(page).getByRole('button', { name: /Notifications/i })] });
    });
  }

  test('W07 AS-02 VN mobile menu open, anonymous; header at 320 px', async ({ page }, testInfo) => {
    testInfo.skip(!isPhone(page), 'phone layout');
    await stubSession(page, null);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/privacy');
    await expect(header(page).getByRole('link', { name: 'Log in' })).toBeVisible();
    await shot(header(page), 'header-320.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open menu' }).click();
    const sheet = page.getByRole('dialog', { name: 'Menu' });
    await expect(sheet.getByRole('link', { name: 'Browse' })).toBeVisible();
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
    await shot(sheet, 'menu-open.png');
  });

  test('W07 AS-03 VN search row open (mobile)', async ({ page }, testInfo) => {
    testInfo.skip(!isPhone(page), 'phone layout');
    await stubSession(page, null);
    await page.goto('/privacy');
    await header(page).getByRole('button', { name: 'Search' }).click();
    await expect(header(page).getByRole('combobox', { name: 'Search products' })).toBeFocused();
    await shot(header(page), 'search-row.png');
  });

  test('W07 AS-06 VN first paint with a dark OS preference', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await stubSession(page, null);
    await page.goto('/terms');
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await shotPage(page, 'terms-dark.png', { fullPage: false });
  });

  test('W07 AS-07 VN skip link visible on focus, and focus rings', async ({ page }, testInfo) => {
    testInfo.skip(isPhone(page), 'keyboard layout');
    await stubSession(page, null);
    await page.goto('/privacy');
    await expect(header(page).getByRole('link', { name: 'Log in' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await shot(header(page), 'skip-link-focus.png');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(header(page).getByRole('link', { name: 'Browse' })).toBeFocused();
    await shot(header(page), 'focus-ring-header.png');
    await page.getByRole('contentinfo').getByRole('link', { name: 'Terms' }).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await shot(page.getByRole('contentinfo'), 'focus-ring-footer.png');
  });

  test('W07 AS-08 VN footer', async ({ page }) => {
    await stubSession(page, null);
    await page.goto('/terms');
    await page.getByRole('contentinfo').scrollIntoViewIfNeeded();
    await shot(page.getByRole('contentinfo'), 'footer.png');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`W07 AS-09 VN not-found page (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await stubSession(page, null);
      await page.goto('/definitely/not/a/page');
      await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
      await shotPage(page, `not-found-${scheme}.png`);
    });
  }

  test('W07 AS-14 VN the offline bar', async ({ page }) => {
    await stubSession(page, null);
    await page.goto('/privacy');
    await page.context().setOffline(true);
    const bar = page.getByRole('status').filter({ hasText: "You're offline" });
    await expect(bar).toBeVisible();
    await shot(bar, 'offline-bar.png');
    await page.context().setOffline(false);
    await expect(page.getByRole('status').filter({ hasText: 'Back online.' })).toBeVisible();
  });

  test('W07 AS-23 VN privacy page', async ({ page }) => {
    await stubSession(page, null);
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeVisible();
    await shotPage(page, 'privacy.png', { fullPage: true });
  });

  test('W07 AS-24 VN terms page', async ({ page }) => {
    await stubSession(page, null);
    await page.goto('/terms');
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeVisible();
    await shotPage(page, 'terms.png', { fullPage: true });
  });

  test('W07 AS-25 VN legal navigation: sticky rail (desktop), disclosure open (phone)', async ({ page }) => {
    await stubSession(page, null);
    await page.goto('/privacy');
    if (isPhone(page)) {
      const disclosure = page.locator('details').filter({ hasText: 'On this page' });
      await disclosure.getByText('On this page').click();
      await shot(disclosure, 'legal-disclosure-open.png');
    } else {
      await shot(page.getByRole('navigation', { name: 'On this page' }), 'legal-rail.png');
    }
  });

  test('W07 AS-27 VN developer docs (fixture description)', async ({ page }) => {
    await stubSession(page, null);
    await page.route('**/api/developers/openapi.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(docsFixture) }));
    await page.goto('/developers/docs');
    const expander = page.getByRole('button', { name: /GET\s*\/v1\/products/ });
    await expect(expander).toBeVisible({ timeout: 15_000 });
    await expander.click();
    await expect(page.getByRole('region', { name: /GET\s*\/v1\/products/ })).toBeVisible();
    await shotPage(page, 'docs.png', { fullPage: true });
  });

  test('W07 AS-28 VN developer docs, description unavailable', async ({ page }) => {
    await stubSession(page, null);
    await page.route('**/api/developers/openapi.json', (route) =>
      route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ status: 503, code: 'service_unavailable', requestId: 'req-visual-1' }) }),
    );
    await page.goto('/developers/docs');
    await expect(page.getByText('The API reference is temporarily unavailable.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { level: 2, name: 'Operations' })).toBeVisible();
    await shotPage(page, 'docs-unavailable.png', { fullPage: true });
  });
});
