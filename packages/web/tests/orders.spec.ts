import { test, expect } from '@playwright/test';
import { createIsolatedProduct, register } from './helpers';

/**
 * W03 journey JO-1 against the real dev stack: a member places an order without paying, finds it in Your orders with Pay now
 * and Cancel, opens its detail and cancels it.
 */
test.describe('Orders @desktop', () => {
  test.beforeEach(async ({ page }) => {
    // Real `add_to_cart` events would fill the shared dev stack's trending ranking (W02's layout specs assume it is empty).
    await page.addInitScript(() => {
      navigator.sendBeacon = () => false;
    });
    await page.route('**/api/events', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
  });

  test('JO-1 place an order, see it in Your orders, open it and cancel it', async ({ page }) => {
    const { id, title } = await createIsolatedProduct({ quantity: 200 });
    await register(page);
    await page.goto(`/products/${id}`);
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText('Added to cart')).toBeVisible();
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/checkout\/pay\/[0-9a-f-]{36}$/);
    const orderId = page.url().split('/').pop() as string;
    const short = orderId.slice(0, 8).toUpperCase();

    // Not paid: the order is in the history with Pay now and Cancel.
    await page.goto('/orders');
    await expect(page.getByRole('heading', { level: 1, name: 'Your orders' })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: `Order #${short}` });
    await expect(row.getByText('Awaiting payment')).toBeVisible();
    await expect(row.getByRole('link', { name: 'Pay now' })).toHaveAttribute('href', `/checkout/pay/${orderId}`);
    await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();

    // The detail: timeline and the shop slice.
    await row.getByRole('link', { name: `View order #${short}` }).click();
    await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));
    await expect(page.getByRole('heading', { level: 1, name: `Order #${short}` })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Order timeline' }).getByText('Awaiting payment')).toBeVisible();
    await expect(page.getByRole('link', { name: title })).toBeVisible();

    // Cancel with the confirmation.
    await page.getByRole('button', { name: 'Cancel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this order?' });
    await expect(dialog.getByRole('button', { name: 'Keep order' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByText('Order cancelled').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Buy these items again' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pay now' })).toHaveCount(0);

    await page.goto('/orders');
    await expect(page.getByRole('row').filter({ hasText: `Order #${short}` }).getByText('Cancelled')).toBeVisible();
  });

  test('JO-1 the old dashboard address lands on Your orders', async ({ page }) => {
    await register(page);
    await page.goto('/dashboard/orders');
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Your orders' })).toBeVisible();
  });
});
