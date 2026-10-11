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

  test('search: no horizontal scroll at 320 px', async ({ page }) => {
    await page.goto('/search?q=espresso&inStock=true&minPriceMinor=1000');
    await expect(grid(page)).toBeVisible();
    await page.setViewportSize({ width: 320, height: 700 });
    await expectNoHorizontalScroll(page);
  });
});
