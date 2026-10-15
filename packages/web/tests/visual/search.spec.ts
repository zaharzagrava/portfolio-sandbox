import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousViolations } from './axe';
import { productId } from '../helpers';

/**
 * VS rows of W02 (AS-10, AS-14, AS-19, AS-25..AS-27, AS-75): the search page's layout at the phone (390 x 844) and
 * desktop (1280 x 800) widths against the seeded stack. Screenshots cover the controls (filter panel, toolbar, chips,
 * empty state), never the product grid, whose content other journeys change.
 */

const mobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;
const grid = (page: Page) => page.getByTestId('search-results');

test.describe('Search layout', () => {
  test.beforeEach(async () => {
    await productId();
  });

  test('search: results, desktop sidebar vs mobile sheet, grid columns', async ({ page }) => {
    await page.goto('/search?q=espresso');
    await expect(grid(page)).toBeVisible();

    const columns = await grid(page).evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(mobile(page) ? 2 : 4);

    const filtersButton = page.getByRole('button', { name: /^Filters/ });
    const panel = page.getByRole('form', { name: 'Filters' });
    if (mobile(page)) {
      await expect(filtersButton).toBeVisible();
      await expect(panel).toBeHidden();
      await filtersButton.click();
      const sheet = page.getByRole('dialog', { name: 'Filters' });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole('button', { name: /^Show / })).toBeInViewport();
      await expect(sheet.getByRole('button', { name: 'Clear all' })).toBeInViewport();
      await expectNoSeriousViolations(page);
      await expect(sheet).toHaveScreenshot('filters-sheet.png');
    } else {
      await expect(filtersButton).toBeHidden();
      await expect(panel).toBeVisible();
      const panelBox = (await panel.boundingBox())!;
      const gridBox = (await grid(page).boundingBox())!;
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(gridBox.x); // the filter column is left of the grid
      expect(panelBox.width).toBeGreaterThanOrEqual(240); // 16 rem
      await expect(panel).toHaveScreenshot('filters-panel.png');
    }
  });

  test('search: toolbar and chips', async ({ page }) => {
    await page.goto('/search?q=espresso&inStock=true&minRating=4&minPriceMinor=1000&maxPriceMinor=100000');
    const chips = page.getByRole('list', { name: 'Active filters' });
    await expect(chips).toBeVisible();
    await expect(chips.getByRole('button', { name: 'Remove filter In stock' })).toBeVisible();
    await expect(chips.getByRole('button', { name: 'Clear all filters' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toBeVisible();
    await expect(chips).toHaveScreenshot('chips.png');
    await expectNoSeriousViolations(page);
  });

  test('search: filters panel states, price error', async ({ page }) => {
    await page.goto('/search?q=espresso');
    const scope = mobile(page) ? (await page.getByRole('button', { name: /^Filters/ }).click(), page.getByRole('dialog', { name: 'Filters' })) : page.locator('body');
    await scope.getByLabel('Minimum price').fill('50');
    await scope.getByLabel('Maximum price').fill('10');
    await scope.getByRole('button', { name: 'Apply' }).click();
    await expect(scope.getByText("The minimum price can't be higher than the maximum.")).toBeVisible();
    await expect(scope.getByLabel('Minimum price')).toHaveAttribute('aria-invalid', 'true');
    await expectNoSeriousViolations(page);
  });

  test('search: results empty', async ({ page }) => {
    await page.goto('/search?q=zzqqxxnomatch');
    await expect(page.getByText('No products match your search.')).toBeVisible();
    await expect(page.getByText('Try a different spelling or fewer words.')).toBeVisible();
    await expect(page.getByTestId('search-empty')).toHaveScreenshot('results-empty.png');
    await expectNoSeriousViolations(page);
  });

  test('search: refreshing keeps the previous results dimmed and busy', async ({ page }) => {
    await page.goto('/search?q=espresso');
    await expect(grid(page)).toBeVisible();
    await page.route('**/api/products/search**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await page.getByRole('combobox', { name: 'Sort by' }).selectOption('price-desc');
    const region = page.getByRole('region', { name: 'Search results' });
    await expect(region).toHaveAttribute('aria-busy', 'true');
    await expect(grid(page)).toBeVisible(); // no empty flash
    const opacity = await grid(page).evaluate((node) => Number(getComputedStyle(node.parentElement!).opacity));
    expect(opacity).toBeLessThan(1);
    await expect(region).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 });
  });

  test('search: structure, landmarks and focus order', async ({ page }) => {
    await page.goto('/search?q=espresso');
    await expect(grid(page)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Search results' })).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test.describe('pickup mode', () => {
    test.use({ geolocation: { latitude: 52.52, longitude: 13.405 }, permissions: ['geolocation'] });

    test('search: pickup mode', async ({ page }) => {
      // Layout only (VS): the pickup answer is stubbed so the cards, distances and counts never change.
      await page.route('**/api/search/near**', (route) =>
        route.fulfill({
          json: {
            items: ['Espresso Machine', 'Milk Frother', 'Coffee Grinder', 'Tamper'].map((title, index) => ({
              productId: `3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a0${index}`,
              title,
              category: 'kitchen',
              priceMinor: 19900 + index * 1000,
              currency: 'USD',
              nearest: { pickupPointId: `5d0e6f7a-1b2c-4d3e-8f4a-5b6c7d8e9f0${index}`, name: `Locker ${index + 1}`, distanceM: 850 + index * 700, quantity: 3 + index },
            })),
            nextCursor: null,
          },
        }),
      );
      await page.goto('/search?q=espresso&brand=Test&near=1&radiusKm=10');
      await expect(grid(page)).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Pickup near you' })).toBeVisible();
      await expect(page.getByText('850 m away · Locker 1 · 3 available')).toBeVisible();
      await expect(page.getByRole('switch', { name: 'Available for pickup near me' })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('combobox', { name: 'Radius' })).toHaveValue('10');
      await expect(page.getByRole('combobox', { name: 'Sort by' })).toBeDisabled();
      if (!mobile(page)) {
        await expect(page.getByRole('form', { name: 'Filters' }).getByText('Not available together with pickup search.')).toBeVisible();
      }
      const columns = await grid(page).evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
      expect(columns).toBe(mobile(page) ? 2 : 4);
      await expectNoSeriousViolations(page);
      await expect(page.getByRole('region', { name: 'Search results' })).toHaveScreenshot('pickup-mode.png');
    });

    test('search: pickup mode, location denied', async ({ page, context }) => {
      await context.clearPermissions();
      await page.goto('/search?q=espresso');
      await expect(grid(page)).toBeVisible();
      await page.getByRole('switch', { name: 'Available for pickup near me' }).click();
      await expect(page.getByText('Location is off. Allow location access in your browser to find pickup near you.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect(page).not.toHaveURL(/near=/);
      await expectNoSeriousViolations(page);
    });
  });

  test('search: no horizontal scroll at 320 px', async ({ page }) => {
    await page.goto('/search?q=espresso&inStock=true&minPriceMinor=1000');
    await expect(grid(page)).toBeVisible();
    await page.setViewportSize({ width: 320, height: 700 });
    await expectNoHorizontalScroll(page);
  });
});
