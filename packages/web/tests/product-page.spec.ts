import { test, expect } from '@playwright/test';
import { SEED, productId } from './helpers';

/** The product page against the seeded catalogue (S48 aggregate through the BFF, S05 public view). */
test.describe('Product page @desktop', () => {
  test('product page shows price, stock and stays purchasable without its optional sections', async ({ page }) => {
    const id = await productId();
    await page.goto(`/products/${id}`);

    await expect(page.getByRole('heading', { level: 1, name: SEED.product })).toBeVisible();
    await expect(page).toHaveTitle(`${SEED.product} · Marketplace`);
    await expect(page.getByTestId('product-price')).toHaveText('€899.99');
    await expect(page.getByText('In stock', { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(SEED.product);

    // The dev seed has no product images, trending data or recommendations: those sections are simply absent.
    await expect(page.getByTestId('gallery-placeholder')).toBeVisible();
    await expect(page.getByText(/UPSTREAM_|BUDGET_EXCEEDED|CIRCUIT_OPEN/)).toHaveCount(0);

    // ...and the purchase area works.
    const add = page.getByRole('button', { name: /add to cart/i }).first();
    await expect(add).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Chat with seller' })).toHaveAttribute('href', `/chat?product=${id}`);
  });

  test('the tab is in the address and a deep link opens it', async ({ page }) => {
    const id = await productId();
    await page.goto(`/products/${id}?tab=discussions`);
    await expect(page.getByRole('tab', { name: 'Discussions' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Details' }).click();
    await expect(page).toHaveURL(new RegExp(`/products/${id}$`));
    await page.getByRole('tab', { name: 'Ask about this product' }).click();
    await expect(page).toHaveURL(/\?tab=ask$/);
  });

  test('the short address /p/{id} redirects and keeps the query', async ({ page }) => {
    const id = await productId();
    await page.goto(`/p/${id}?ref=friend`);
    await expect(page).toHaveURL(new RegExp(`/products/${id}\\?ref=friend$`));
    await expect(page.getByRole('heading', { level: 1, name: SEED.product })).toBeVisible();
  });

  test('an unknown product is one not-found state, marked noindex', async ({ page }) => {
    await page.goto('/products/3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b');
    await expect(page.getByText("We couldn't find that product.")).toBeVisible();
    await expect(page.getByRole('link', { name: 'Search products' })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(1);
  });

  test('a malformed product id is the same not-found state', async ({ page }) => {
    await page.goto('/products/not-a-product');
    await expect(page.getByText("We couldn't find that product.")).toBeVisible();
  });
});
