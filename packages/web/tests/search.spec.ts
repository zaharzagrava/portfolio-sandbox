import { test, expect } from '@playwright/test';
import { SEED, ensureCatalogueSize, openFiltersIfCollapsed, productId } from './helpers';

/** Home → search → product page, against the seeded catalogue (S32 search, S33 suggestions, S35 trending fallback). */
test.describe('Catalog & search @desktop', () => {
  test('home lists products', async ({ page }) => {
    await productId(); // indexed
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Search products' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Trending now' })).toBeVisible();
    const cards = page.getByTestId('home-products').getByRole('link');
    await expect(cards.first()).toBeVisible();
    await expect(cards.first()).toHaveAttribute('href', /^\/products\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/Count-Min Sketch/i)).toHaveCount(0);
  });

  test('type iph, pick a suggestion', async ({ page }) => {
    // Needs the suggestion dataset of S33 (five suggestions for "iph"); the dev seed has no such queries yet (questions.md Q-W02-1).
    test.fixme(true, 'S33 dataset S is not seeded in the dev stack');
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Search products' }).fill('iph');
    await expect(page.getByRole('option')).toHaveCount(5);
    await page.getByRole('option', { name: 'iphone 17', exact: true }).click();
    await expect(page).toHaveURL(/\/search\?q=iphone\+17$/);
  });

  test('type espr, pick a suggestion', async ({ page }) => {
    await productId();
    await page.goto('/');
    const box = page.getByRole('combobox', { name: 'Search products' });
    await box.pressSequentially('espr');
    // The suggestion is the query-log form (lowercase) once someone has searched it, and the catalogue title (as written) before that.
    const option = page.getByRole('option', { name: /^espresso machine titanium$/i });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page).toHaveURL(/\/search\?q=espresso\+machine\+titanium$/i);
    await expect(page.getByRole('heading', { level: 1, name: /^Results for “espresso machine titanium”$/i })).toBeVisible();
  });

  test('search finds one', async ({ page }) => {
    await productId();
    await page.goto('/search?q=espresso');
    await expect(page.getByRole('heading', { level: 1, name: 'Results for “espresso”' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Search results' }).getByText(/^\d[\d,]* results?$/)).toBeVisible();
    await expect(page.getByTestId('product-card').filter({ hasText: SEED.product }).first()).toBeVisible();
  });

  test('typing in the search box on the search page keeps the address in step', async ({ page }) => {
    await productId();
    await page.goto('/search?sort=price-asc');
    const box = page.getByRole('combobox', { name: 'Search products' });
    await box.fill('espresso');
    await box.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=espresso&sort=price-asc$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Results for “espresso”' })).toBeVisible();
  });

  test('filters and sort are in the address; reload and back restore the view', async ({ page }) => {
    await productId();
    await page.goto('/search?q=espresso');

    // Sort: Price: high to low
    await page.getByRole('combobox', { name: 'Sort by' }).selectOption('price-desc');
    await expect(page).toHaveURL(/sort=price-desc/);

    // Facets: when the search API serves them, a category facet is chosen and its siblings stay (S32 US2).
    const filters = await openFiltersIfCollapsed(page);
    const category = filters.getByRole('group', { name: 'Category' });
    if (await category.count()) {
      await category.getByRole('button').first().click();
      await expect(page).toHaveURL(/category=/);
      await expect(category.getByRole('button').first()).toBeVisible();
    }

    // Price 10 to 500 (major units) becomes minor units in the address.
    await filters.getByLabel('Minimum price').fill('10');
    await filters.getByLabel('Maximum price').fill('500');
    await filters.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/minPriceMinor=1000&maxPriceMinor=50000/);
    const address = page.url();

    // Reload restores the same view.
    await page.reload();
    await expect(page).toHaveURL(address);
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('price-desc');

    // Back removes the last change.
    await page.goBack();
    await expect(page).not.toHaveURL(/minPriceMinor/);
    await expect(page).toHaveURL(/sort=price-desc/);
  });

  test('next page keeps the filters and the browser back button returns', async ({ page }) => {
    await productId();
    await ensureCatalogueSize(30); // a page holds 24; a fresh stack seeds 12
    await page.goto('/search?sort=newest');
    const next = page.getByRole('link', { name: 'Next page' });
    await expect(next).toBeVisible();
    const first = await page.getByTestId('product-card').first().textContent();
    await next.click();
    await expect(page).toHaveURL(/sort=newest&cursor=/);
    await expect(page.getByRole('link', { name: 'Back to first page' })).toBeVisible();
    await page.goBack();
    await expect(page).not.toHaveURL(/cursor=/);
    await expect(page.getByTestId('product-card').first()).toHaveText(first ?? '');
  });

  test('home → search → product', async ({ page }) => {
    const id = await productId();
    await page.goto('/');
    const box = page.getByRole('combobox', { name: 'Search products' });
    await box.fill('espresso');
    await box.press('Enter');
    await expect(page).toHaveURL(/q=espresso/);
    await page.getByTestId('product-card').filter({ hasText: SEED.product }).first().getByRole('link').click();

    await expect(page).toHaveURL(new RegExp(`/products/${id}$`));
    await expect(page.getByRole('heading', { level: 1, name: SEED.product })).toBeVisible();
    await expect(page.getByTestId('product-price')).toHaveText('€899.99');
    await expect(page.getByText('In stock', { exact: true })).toBeVisible();
  });
});
