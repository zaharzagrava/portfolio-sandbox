import { expect, test } from '@playwright/test';
import { PROD_PORT } from '../playwright.config';

// The loading placeholder of a navigation comes from the loading boundary the router prefetched, which only a production
// build does: Playwright starts it on its own port when this file is targeted (see playwright.config.ts).
test.use({ baseURL: `http://localhost:${PROD_PORT}` });

test.describe('W07 app shell (production build)', () => {
  test('W07 AS-12: slow page keeps header and footer and shows a placeholder', async ({ page }) => {
    await page.goto('/terms');
    // let the router prefetch the target's loading boundary, then hold the real navigation back like a slow server would
    await page.getByRole('contentinfo').scrollIntoViewIfNeeded(); // links are prefetched once they are in view
    await page.waitForLoadState('networkidle');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === '/search' && url.searchParams.has('_rsc'),
      async (route) => {
        if (route.request().headers()['next-router-prefetch']) return route.continue();
        await held;
        return route.continue();
      },
    );
    await page.getByRole('contentinfo').getByRole('link', { name: 'Browse' }).click();
    const busy = page.locator('[aria-busy="true"]').first();
    await expect(busy).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();
    await expect(page).toHaveScreenshot('loading-skeleton.png', { mask: [page.getByRole('banner')] });
    release();
    await expect(page).toHaveURL(/\/search/);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
  });
});
