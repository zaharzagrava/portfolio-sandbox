import { test, expect } from '@playwright/test';
import { SEED, payWithSandboxCard, productId, register } from './helpers';

/**
 * W03 journeys JC-1 and JC-3 against the real dev stack: a guest adds to the cart, signs up and keeps it; the last line is
 * removed. The purchase path (JC-2) and the sign-in redirects (JC-4) are added with the pay and success pages.
 */
test.describe('Cart & checkout', () => {
  // The journeys really add to the cart, so the browser sends `add_to_cart`. The request is still made (and observed below),
  // but it is answered here: real events would fill the shared dev stack's trending ranking for an hour, and W02's page
  // layout specs assume that ranking is empty.
  // A beacon (sent when the page is hidden) is not seen by `page.route`, so the beacon is refused and the keep-alive request
  // that `sendEvents` falls back to is the one answered here.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      navigator.sendBeacon = () => false;
    });
    await page.route('**/api/events', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
  });

  test('JC-1 guest adds from a product page, sees the badge, signs up and keeps the line', async ({ page }) => {
    const id = await productId();
    const events: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/events') && request.method() === 'POST') events.push(request.postData() ?? '');
    });

    await page.goto(`/products/${id}`);
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText('Added to cart')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cart, 1 item' }).or(page.getByRole('link', { name: 'Cart, 1 items' }))).toBeVisible();
    // Events are batched; the queue flushes within a few seconds.
    await expect.poll(() => events.some((body) => body.includes('add_to_cart') && body.includes(id)), { timeout: 20_000 }).toBe(true);

    // Signing up moves the guest cart into the member's cart.
    await register(page);
    await page.goto('/cart');
    await expect(page.getByRole('heading', { level: 1, name: 'Your cart' })).toBeVisible();
    await expect(page.getByRole('link', { name: SEED.product })).toBeVisible();
    await expect(page.getByRole('group', { name: `Quantity of ${SEED.product}` })).toBeVisible();
  });

  test('JC-2 cart quantity, checkout, place order, pay with the sandbox card', async ({ page }) => {
    const id = await productId();
    await register(page);
    await page.goto(`/products/${id}`);
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText('Added to cart')).toBeVisible();

    await page.goto('/cart');
    const subtotal = page.getByText(/^Subtotal \(/).first();
    await expect(subtotal).toContainText('1 item');
    await page.getByRole('button', { name: `Increase quantity of ${SEED.product}` }).click();
    await expect(subtotal).toContainText('2 items');

    await page.getByRole('link', { name: 'Checkout', exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/checkout\/pay\/[0-9a-f-]{36}$/);

    await payWithSandboxCard(page);
    // This stack's provider key is a dummy (research.md R-08): the payment stays in progress unless the stack settles it,
    // and the page must never claim success before the order is paid.
    const processing = page.getByText('Payment is being processed…');
    const confirmed = page.getByRole('heading', { name: 'Order confirmed' });
    await expect(processing.or(confirmed)).toBeVisible({ timeout: 20_000 });
    if (await confirmed.isVisible()) {
      await expect(page).toHaveURL(/\/checkout\/success\//);
      await expect(page.getByRole('link', { name: 'View order' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Continue shopping' })).toBeVisible();
    } else {
      await page.goto(page.url().replace('/checkout/pay/', '/checkout/success/'));
      await expect(page.getByRole('heading', { name: 'Order confirmed' })).toHaveCount(0);
    }
  });

  test('W03 AS-14: JC-4 anonymous visitors are sent to sign-in with returnTo from the checkout URLs', async ({ page }) => {
    const orderId = '00000000-0000-4000-8000-000000000001';
    // TODO(T081): add `/orders` and `/orders/{id}` when the orders pages exist (user story 5).
    for (const path of ['/checkout', `/checkout/pay/${orderId}`, `/checkout/success/${orderId}`]) {
      // The redirect to sign-in can abort the navigation that triggered it (net::ERR_ABORTED); the destination is what is asserted.
      await page.goto(path).catch((error: Error) => {
        if (!/ERR_ABORTED/.test(error.message)) throw error;
      });
      await expect(page).toHaveURL(new RegExp(`/login\\?returnTo=${encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  });

  test('JC-3 removing the last line empties the cart', async ({ page }) => {
    const id = await productId('Burr Coffee Grinder');
    await page.goto(`/products/${id}`);
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText('Added to cart')).toBeVisible();
    await page.goto('/cart');
    await page.getByRole('button', { name: /^Remove/ }).click();
    await expect(page.getByText('Your cart is empty')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  });
});
