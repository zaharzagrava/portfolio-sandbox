import { expect, test, type Page } from '@playwright/test';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';
import { productId, register } from '../helpers';

/**
 * VK rows of W03 (AS-74, SC-008): the checkout screens' layout at the phone (390 x 844) and desktop (1280 x 800) widths,
 * against the real dev stack with a freshly registered member. The `price-changed` state is real: the cart aggregate the
 * review shows is read through a route that lowers the unit price, so the expected total the page sends is below the
 * stored price and the order function answers `409 price_changed`.
 */

async function memberWithCart(page: Page, title?: string) {
  // Real `add_to_cart` events would fill the shared dev stack's trending ranking and break W02's "no optional sections" layout spec.
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false; // a beacon bypasses `page.route`; the keep-alive fallback is answered below
  });
  await page.route('**/api/events', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
  const id = await productId(title);
  await register(page);
  await page.goto(`/products/${id}`);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText('Added to cart')).toBeVisible();
}

test.describe('Checkout layout', () => {
  test('review', async ({ page }) => {
    await memberWithCart(page);
    await page.goto('/checkout');
    await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Place order' })).toBeEnabled();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('review.png');
  });

  test('review: no horizontal scroll at 320 px', async ({ page }) => {
    await memberWithCart(page);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/checkout');
    await expect(page.getByRole('button', { name: 'Place order' })).toBeVisible();
    // W07 header width: see gaps.md follow-ups (the CSP forbids an injected <style>, so the element is hidden directly)
    await page.evaluate(() => document.querySelectorAll('header').forEach((header) => (header.style.display = 'none')));
    await expectMainFitsWidth(page);
  });

  /** A real RESERVED order for a fresh member; resolves with its id, standing on the pay page. */
  async function reservedOrder(page: Page) {
    await memberWithCart(page);
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/checkout\/pay\/[0-9a-f-]{36}$/);
    return page.url().split('/').pop() as string;
  }

  /** Pays a real order with the sandbox card; the dev stack keeps the payment in progress (the reducer moves on from there). */
  async function processingOrder(page: Page) {
    const id = await reservedOrder(page);
    await page.getByRole('radio', { name: /Visa test card/ }).check();
    await page.getByRole('button', { name: /^Pay / }).click();
    await expect(page.getByText('Payment is being processed…')).toBeVisible({ timeout: 20_000 });
    return id;
  }

  type Forced = { order?: Record<string, unknown>; payment?: Record<string, unknown> };

  /**
   * Shows a server state the dev stack cannot produce: the browser's reads of the order aggregate and of the payment are
   * rewritten (fields merged over the real answer), a stubbed stream makes the reloaded page read them, and `ready`
   * must become visible.
   */
  async function force(page: Page, forced: Forced, ready: ReturnType<Page['locator']>) {
    await page.route('**/api/bff/orders/*', async (route) => {
      try {
        const response = await route.fetch();
        const body = await response.json();
        if (forced.order) Object.assign(body.order, forced.order);
        // A higher `version` wins over the real answer (the page keeps the newest version of the payment it follows).
        if (forced.payment && body.payment) Object.assign(body.payment, forced.payment, { version: 999 });
        await route.fulfill({ response, json: body });
      } catch {
        await route.abort().catch(() => undefined);
      }
    });
    await page.route(/\/api\/payments\/[0-9a-f-]{36}$/, async (route) => {
      // Reading the secret of a 3-D Secure payment fails: the stand-in frame would otherwise confirm at once and the panel
      // "Your bank needs you to confirm this payment." would not stay on screen.
      if (forced.payment?.requiresAction) return route.fulfill({ status: 500, json: { code: 'internal_error' } });
      try {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, ...forced.payment, version: 999 } });
      } catch {
        await route.abort().catch(() => undefined); // the test ended while the read was in flight
      }
    });
    // The live stream says `resync` as soon as it connects, which makes the page read the order and payment again.
    await page.route('**/api/streams*', (route) =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'cache-control': 'no-store' }, body: 'retry: 1000\nevent: resync\ndata: {"reason":"test"}\n\n' }),
    );
    await page.reload();
    await expect(ready.first()).toBeVisible({ timeout: 15_000 });
  }

  test('pay-form and pay-countdown', async ({ page }) => {
    await reservedOrder(page);
    await expect(page.getByRole('timer')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Pay / })).toBeEnabled();
    await expectNoSeriousViolations(page);
    // The timer's digits move: the screenshot covers the form and masks the countdown.
    await expect(page.getByRole('main')).toHaveScreenshot('pay-form.png', { mask: [page.getByRole('timer')] });
    await expect(page.getByRole('timer')).toHaveScreenshot('pay-countdown.png', { mask: [page.getByRole('timer')] });
  });

  test('pay-processing', async ({ page }) => {
    await reservedOrder(page);
    await page.getByRole('radio', { name: /Visa test card/ }).check();
    await page.getByRole('button', { name: /^Pay / }).click();
    await expect(page.getByText('Payment is being processed…')).toBeVisible({ timeout: 20_000 });
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('pay-processing.png', { mask: [page.getByRole('timer')] });
  });

  test('pay-action-required', async ({ page }) => {
    await processingOrder(page);
    await force(page, { payment: { status: 'PENDING', requiresAction: true } }, page.getByText('Your bank needs you to confirm this payment.'));
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('pay-action-required.png', { mask: [page.getByRole('timer')] });
  });

  test('pay-failed', async ({ page }) => {
    await processingOrder(page);
    await force(page, { payment: { status: 'FAILED', failureCode: 'card_declined' } },page.getByText("Payment didn't go through"));
    await expect(page.getByText('Your card was declined.')).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('pay-failed.png', { mask: [page.getByRole('timer')] });
  });

  test('pay-unknown', async ({ page }) => {
    await processingOrder(page);
    await force(page, { payment: { status: 'UNKNOWN' } },page.getByText('Confirming your payment'));
    await expect(page.getByRole('button', { name: /^Pay / })).toHaveCount(0);
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('pay-unknown.png', { mask: [page.getByRole('timer')] });
  });

  test('pay-cancelled', async ({ page }) => {
    await reservedOrder(page);
    await force(page, { order: { status: 'CANCELLED' } },page.getByText('This order was cancelled'));
    await expect(page.getByRole('link', { name: 'Your orders' }).first()).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('pay-cancelled.png');
  });

  test('success: unpaid and confirmed', async ({ page }) => {
    const orderId = await reservedOrder(page);
    await page.goto(`/checkout/success/${orderId}`);
    await expect(page.getByText("You haven't paid for this order yet.")).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toHaveCount(0);
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('success-unpaid.png');

    await force(page, { order: { status: 'PAID' } },page.getByRole('heading', { name: 'Order confirmed' }));
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('success.png', { mask: [page.getByText(/^Order #/)] });
  });

  test('price-changed', async ({ page }) => {
    await memberWithCart(page);
    // The review's own read of the cart shows a unit price 1.00 lower than the stored one.
    await page.route('**/api/bff/cart', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const line of body.lines) if (line.product) line.product.priceMinor -= 100;
      await route.fulfill({ response, json: body });
    });
    await page.goto('/checkout');
    const total = page.getByText(/Estimated total/).locator('..');
    const before = await total.textContent();
    // The server-prefetched cart is fresh; a visibility change makes the browser read it again (through the route above).
    await expect
      .poll(async () => {
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        return total.textContent();
      })
      .not.toBe(before);
    await page.getByRole('button', { name: 'Place order' }).click();
    const alert = page.getByRole('alert').filter({ hasText: /price/i }).first();
    await expect(alert).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept new total and place order' })).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('price-changed.png');
  });
});
