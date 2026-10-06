import { test, expect } from '@playwright/test';
import { SEED, productId, register } from './helpers';

/** SD-19 happy path: guest cart → sign-up merges it → quantities → checkout reserves stock → order history → cancel. */
test.describe('Cart & checkout', () => {
  test('guest cart survives sign-up, checks out, and the order can be cancelled', async ({ page }) => {
    const id = await productId();

    // Guest adds to cart (signed cookie cart).
    await page.goto(`/products/${id}`);
    await page.getByRole('button', { name: 'Add to Cart' }).click();
    await expect(page.getByText('Added to cart')).toBeVisible();

    // Signing up moves the guest cart into the user's cart.
    await register(page);
    await page.goto('/cart');
    const line = page.getByTestId('cart-line');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(SEED.product);

    await page.getByRole('button', { name: 'Increase quantity' }).click();
    await expect(page.getByTestId('cart-line-quantity')).toHaveText('2');
    await expect(page.getByTestId('cart-subtotal')).toHaveText('$1,799.98');

    await page.getByRole('link', { name: 'Proceed to Checkout' }).click();
    await expect(page.getByTestId('checkout-total')).toHaveText('$1,799.98');
    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page).toHaveURL(/\/checkout\/success\?orderId=/);

    // The cart is now empty; the order shows up reserved and can still be cancelled (unpaid).
    await page.goto('/cart');
    await expect(page.getByTestId('cart-empty')).toBeVisible();
    await page.goto('/dashboard/orders');
    await expect(page.getByTestId('order-row')).toHaveCount(1);
    await expect(page.getByTestId('order-status')).toHaveText('RESERVED');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('order-status')).toHaveText('CANCELLED');
  });

  test('removing the last line empties the cart', async ({ page }) => {
    const id = await productId('Burr Coffee Grinder');
    await page.goto(`/products/${id}`);
    await page.getByRole('button', { name: 'Add to Cart' }).click();
    await expect(page.getByText('Added to cart')).toBeVisible();
    await page.goto('/cart');
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByTestId('cart-empty')).toBeVisible();
  });
});
