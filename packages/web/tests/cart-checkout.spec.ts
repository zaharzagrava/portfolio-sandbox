import { test, expect } from '@playwright/test';
import { SEED, createIsolatedProduct, login, payWithSandboxCard, productId, register, registerThroughUi, signOut } from './helpers';

/**
 * W03 journeys JC-1 to JC-4 against the real dev stack: a guest adds to the cart, signs up and keeps it; the purchase path; the
 * sign-in redirects of every guarded URL and the way back; the last line is removed.
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

    // Signing up moves the guest cart into the member's cart. That merge is a step of the sign-in form's own code, so this journey signs up
    // through the forms (the API sign-in used by the other journeys does not run it).
    await registerThroughUi(page);
    await page.goto('/cart');
    await expect(page.getByRole('heading', { level: 1, name: 'Your cart' })).toBeVisible();
    await expect(page.getByRole('link', { name: SEED.product })).toBeVisible();
    await expect(page.getByRole('group', { name: `Quantity of ${SEED.product}` })).toBeVisible();
  });

  test('JC-2 cart quantity, checkout, place order, pay with the sandbox card', async ({ page }) => {
    // Placing the order reserves stock; the seeded product's stock is finite and shared by every run on this stack.
    const { id, title } = await createIsolatedProduct({ quantity: 200 });
    await register(page);
    await page.goto(`/products/${id}`);
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText('Added to cart')).toBeVisible();

    await page.goto('/cart');
    const subtotal = page.getByText(/^Subtotal \(/).first();
    await expect(subtotal).toContainText('1 item');
    await page.getByRole('button', { name: `Increase quantity of ${title}` }).click();
    await expect(subtotal).toContainText('2 items');

    await page.getByRole('link', { name: 'Checkout', exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/checkout\/pay\/[0-9a-f-]{36}$/);

    await payWithSandboxCard(page);
    // The dev stack settles the payment through its fake provider (IS_LOAD_TEST=true), so the order must become PAID and the page must say so.
    // A payment that stays "being processed" is a defect (2026-10-12: it hid a charge request the queue refused). That the page never claims
    // success before the order is paid is tested in visual/checkout.spec.ts with a forced state.
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 45_000 });
    await expect(page).toHaveURL(/\/checkout\/success\//);
    await expect(page.getByRole('link', { name: 'View order' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue shopping' })).toBeVisible();
  });

  test('W03 AS-14: JC-4 anonymous visitors are sent to sign-in with returnTo from the checkout URLs', async ({ page }) => {
    const orderId = '00000000-0000-4000-8000-000000000001';
    for (const path of ['/checkout', `/checkout/pay/${orderId}`, `/checkout/success/${orderId}`, '/orders', `/orders/${orderId}`]) {
      // Start from a blank page: the sign-in page of the previous round can still be navigating itself, which aborts the next navigation
      // (net::ERR_ABORTED) and leaves the browser on the old URL. The destination is what is asserted.
      await page.goto('about:blank');
      await page.goto(path, { waitUntil: 'commit' }).catch((error: Error) => {
        if (!/ERR_ABORTED/.test(error.message)) throw error;
      });
      await expect(page).toHaveURL(new RegExp(`/login\\?returnTo=${encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  });

  test('W03 AS-14: JC-4 after signing in, the member lands back on the guarded URL they asked for', async ({ page }) => {
    const { email, password } = await register(page);
    await signOut(page);
    await page.goto('/orders', { waitUntil: 'commit' }).catch((error: Error) => {
      if (!/ERR_ABORTED/.test(error.message)) throw error;
    });
    await expect(page).toHaveURL(/\/login\?returnTo=%2Forders/);
    await login(page, email, password, '/orders');
    await expect(page.getByRole('heading', { level: 1, name: 'Your orders' })).toBeVisible();
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
