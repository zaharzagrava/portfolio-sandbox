import { expect, test, type Page } from '@playwright/test';
import { ownerWithShop, watchApi } from '../cross-cutting/support';
import { openInventory } from './support';

/**
 * AI QA map `inventory`, sections "empty" and "error": what the Products region shows while loading and when a read fails
 * (5xx with a reference, 4xx, offline, a session that ended). The list read is the page's own client read (the browser's
 * `GET /api/shops/:id/products`), which the tests answer with a stubbed failure after the page has opened.
 */

const region = (page: Page) => page.getByRole('region', { name: 'Products' });
const LIST = (url: URL) => /^\/api\/shops\/[^/]+\/products$/.test(url.pathname);
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'x', title: 'Boom', status, code, requestId: 'req-state-42', detail: 'SELECT * FROM "Product" at /usr/src/app/product.service.ts:88', ...extra });
/** The browser goes offline and back: the open seller queries refetch once (the page's own rule). */
async function blink(page: Page) {
  await page.context().setOffline(true);
  await expect(page.getByText("You're offline. Changes can't be saved.")).toBeVisible();
  await page.context().setOffline(false);
}

test.describe('Inventory empty and error states', () => {
  test('[inventory.empty.no-flash] while the answer to a changed search is on its way the empty text does not appear', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.empty.no-flash' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Flash Mug' }]);
    await openInventory(page, member, shopId);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // the server render of the new address is what carries the answer (the client read is seeded by it)
    await page.route(/inventory\?.*q=nothing/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.getByLabel('Search your products').fill('nothing here');
    await page.waitForTimeout(900); // past the 300 ms wait, the navigation is on its way and held
    await expect(region(page).getByText(/No products (match|yet)/)).toHaveCount(0);
    release();
    await expect(region(page).getByText('No products match “nothing here”.')).toBeVisible();
  });

  test('[inventory.error.offline] going offline shows the banner; coming back online refetches the open list once', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.error.offline' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'State Mug' }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await blink(page);
    await expect(page.getByText("You're offline. Changes can't be saved.")).toHaveCount(0);
    await expect.poll(() => api.count('GET', /\/products$/)).toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    expect(api.count('GET', /\/products$/), 'one refetch of the list').toBe(1);
    await expect(page.getByRole('rowheader', { name: 'State Mug' })).toBeVisible();
  });

  test('[inventory.error.read-fail, inventory.error.5xx-reference] a 5xx on the list read shows the words, a reference with Copy and no technical text; it is retried at most twice; Try again refetches', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.error.read-fail,inventory.error.5xx-reference' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'State Mug' }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    const failing = (route: import('@playwright/test').Route) => route.fulfill({ status: 503, contentType: 'application/problem+json', body: problem(503, 'internal_error') });
    await page.route((url) => LIST(url), failing);
    await blink(page);
    await expect(region(page).getByRole('alert')).toBeVisible({ timeout: 30_000 });
    const text = await region(page).innerText();
    expect(text).toMatch(/Something went wrong on our side\.|We couldn't load this right now/);
    expect(text).toContain('req-state-42');
    await expect(region(page).getByRole('button', { name: 'Copy reference' })).toBeVisible();
    expect(text).not.toMatch(/SELECT|product\.service|\.ts:|at \/usr|stack/i);
    expect(api.count('GET', /\/products$/), 'a 5xx is retried at most twice').toBeLessThanOrEqual(3);
    // Try again goes to the server again; the server is healthy now
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    api.reset();
    await region(page).getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('rowheader', { name: 'State Mug' })).toBeVisible();
    expect(api.count('GET', /\/products$/)).toBe(1);
  });

  test('[inventory.error.read-fail] a 4xx on the list read is shown once and is not retried by the query', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.error.read-fail-4xx' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Four Mug' }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await page.route((url) => LIST(url), (route) => route.fulfill({ status: 403, contentType: 'application/problem+json', body: problem(403, 'permission_denied') }));
    await blink(page);
    await expect(region(page).getByRole('alert')).toBeVisible();
    const seen = api.count('GET', /\/products$/);
    await page.waitForTimeout(4000); // longer than the two retry delays a 5xx would have used
    expect(api.count('GET', /\/products$/), 'no retry of a 4xx').toBe(seen);
  });

  test('[inventory.error.401] a 401 on the list read runs the session-ended flow once: sign-in with a return to this page', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.error.401' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Auth Mug' }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await page.route((url) => LIST(url), (route) => route.fulfill({ status: 401, contentType: 'application/problem+json', body: problem(401, 'invalid_token') }));
    await blink(page);
    // the session-ended flow: one notice with a Sign in action (the page is not moved by itself)
    const notices = page.locator('[data-sonner-toast]').filter({ hasText: 'Your session ended. Sign in again to continue.' });
    await expect(notices).toHaveCount(1, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    await expect(notices).toHaveCount(1);
    await notices.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    expect(new URL(page.url()).searchParams.get('returnTo')).toContain(`/dashboard/seller/${shopId}/inventory`);
    expect(api.count('DELETE', /\/api\/bff\/session$/)).toBeLessThanOrEqual(1);
  });
});
