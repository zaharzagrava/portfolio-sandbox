import { expect, test } from '@playwright/test';
import { expectMainFitsWidth, expectNoHorizontalScroll, expectNoSeriousViolations } from './axe';
import { SEED, productId } from '../helpers';

/**
 * W02 AS-75, 200 % zoom: a 1280 x 800 window zoomed to 200 % lays the page out in 640 x 400 CSS pixels (the layout does not
 * depend on the device pixel ratio), so the zoomed page is the page at that viewport. Content must fit the width and axe
 * must find nothing serious, on the three storefront pages.
 */
test.describe('200 % zoom', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 400 });
  });

  test('home at 200 %', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page); // the hero's decorative circle sticks out of its clipped box; the page must not scroll
    await expectNoSeriousViolations(page);
  });

  test('search at 200 %', async ({ page }) => {
    await page.goto('/search?q=phone');
    await expect(page.locator('#main-content')).toBeVisible();
    await expectMainFitsWidth(page);
    await expectNoSeriousViolations(page);
  });

  test('product at 200 %', async ({ page }) => {
    const id = await productId();
    await page.goto(`/products/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: SEED.product })).toBeVisible();
    await expectMainFitsWidth(page);
    await expectNoSeriousViolations(page);
  });
});
