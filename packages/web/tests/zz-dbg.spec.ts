import { test, expect } from '@playwright/test';
import { SEED, productId, register } from './helpers';

// Scratch walk through the purchase path, on the W03 UI (it used to drive the pre-W03 cart and checkout).
test('dbg', async ({ page }) => {
  // Real `add_to_cart` events would fill the shared stack's trending ranking and break W02's layout specs.
  await page.route('**/api/events', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
  const id = await productId();
  await page.goto(`/products/${id}`);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText('Added to cart')).toBeVisible();
  await register(page);
  await page.goto('/cart');
  await expect(page.getByRole('link', { name: SEED.product })).toBeVisible();
  const subtotal = page.getByText(/^Subtotal \(/).first();
  await expect(subtotal).toContainText('1 item');
  await page.getByRole('button', { name: `Increase quantity of ${SEED.product}` }).click();
  await expect(subtotal).toContainText('2 items');
  await page.getByRole('link', { name: 'Checkout', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Place order' })).toBeEnabled();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/checkout\/pay\/[0-9a-f-]{36}$/);
  await page.goto('/cart');
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByText('Your cart is empty')).toBeVisible();
});
