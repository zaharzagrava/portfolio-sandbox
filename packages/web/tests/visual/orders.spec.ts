import { expect, test, type Page } from '@playwright/test';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';
import { createIsolatedProduct, register } from '../helpers';

/**
 * VO rows of W03 (AS-74, SC-007, SC-008): the order history and the order detail at the phone (390 x 844) and desktop
 * (1280 x 800) widths, against the real dev stack with a freshly registered member. States the stack cannot produce on
 * demand (a paid order, a payment read that failed) are shown by rewriting the browser's read of the order aggregate; a
 * stubbed stream makes the reloaded page read it again.
 */

async function placeOrder(page: Page): Promise<string> {
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false;
  });
  await page.route('**/api/events', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
  const { id } = await createIsolatedProduct({ quantity: 200 });
  await page.goto(`/products/${id}`);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText('Added to cart')).toBeVisible();
  await page.goto('/checkout');
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/checkout\/pay\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop() as string;
}

async function memberWithOrder(page: Page): Promise<string> {
  await register(page);
  return placeOrder(page);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the aggregate is rewritten field by field
type Rewrite = (body: Record<string, any>) => void;

/** Rewrites the aggregate the browser reads and makes the page read it (the stream says `resync` on connect). */
async function rewriteAggregate(page: Page, rewrite: Rewrite, ready: ReturnType<Page['locator']>) {
  await page.route('**/api/bff/orders/*', async (route) => {
    try {
      const response = await route.fetch();
      const body = await response.json();
      rewrite(body);
      await route.fulfill({ response, json: body });
    } catch {
      await route.abort().catch(() => undefined);
    }
  });
  await page.route('**/api/streams*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'cache-control': 'no-store' }, body: 'retry: 1000\nevent: resync\ndata: {"reason":"test"}\n\n' }),
  );
  await page.reload();
  await expect(ready.first()).toBeVisible({ timeout: 15_000 });
}

test.describe('Orders layout', () => {
  test('list', async ({ page }) => {
    await memberWithOrder(page);
    await page.goto('/orders');
    await expect(page.getByRole('heading', { level: 1, name: 'Your orders' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pay now' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expectNoSeriousViolations(page);
    // The order number and the date change on every run: the screenshot masks them.
    await expect(page.getByRole('main')).toHaveScreenshot('list.png', { mask: [page.locator('tbody th'), page.locator('time')] });
  });

  test('list: no horizontal scroll at 320 px', async ({ page }) => {
    await memberWithOrder(page);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/orders');
    await expect(page.getByRole('link', { name: 'Pay now' })).toBeVisible();
    await page.evaluate(() => document.querySelectorAll('header').forEach((header) => (header.style.display = 'none')));
    await expectMainFitsWidth(page);
  });

  test('empty', async ({ page }) => {
    await register(page);
    await page.goto('/orders');
    await expect(page.getByText("You haven't placed any orders yet.")).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('empty.png');
  });

  test('error', async ({ page }) => {
    await register(page);
    await page.route('**/api/orders?*', (route) => route.fulfill({ status: 400, contentType: 'application/problem+json', json: { status: 400, code: 'invalid_cursor' } }));
    await page.goto('/orders?cursor=broken');
    await expect(page.getByText('This page of orders is no longer available.')).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('error.png');
  });

  test('detail-reserved', async ({ page }) => {
    const id = await memberWithOrder(page);
    await page.goto(`/orders/${id}`);
    await expect(page.getByRole('link', { name: 'Pay now' })).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('detail-reserved.png', {
      mask: [page.getByRole('heading', { level: 1 }), page.locator('time')],
    });
  });

  test('detail-paid', async ({ page }) => {
    const id = await memberWithOrder(page);
    await page.goto(`/orders/${id}`);
    await rewriteAggregate(
      page,
      (body) => {
        body.order.status = 'PAID';
        body.order.timeline.push({ status: 'PAID', reason: null, at: '2026-10-10T10:05:00.000Z' });
        body.payment = {
          id: '11111111-2222-4333-8444-555555555555',
          status: 'COMPLETED',
          amountMinor: body.order.totalMinor,
          currency: 'EUR',
          failureCode: null,
          requiresAction: false,
          version: 9,
          updatedAt: '2026-10-10T10:05:00.000Z',
        };
        body.errors = [];
      },
      page.getByRole('region', { name: 'Payment' }),
    );
    await expect(page.getByRole('link', { name: 'Pay now' })).toHaveCount(0);
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('detail-paid.png', { mask: [page.getByRole('heading', { level: 1 }), page.locator('time')] });
  });

  test('detail-cancelled', async ({ page }) => {
    const id = await memberWithOrder(page);
    await page.goto(`/orders/${id}`);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByRole('button', { name: 'Buy these items again' })).toBeVisible();
    // The toast "Order cancelled" belongs to the app shell (W07); the screen is measured once it is gone.
    await expect(page.getByText('Order cancelled')).toBeHidden({ timeout: 15_000 });
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('detail-cancelled.png', {
      mask: [page.getByRole('heading', { level: 1 }), page.locator('time')],
    });
  });

  test('detail-partial', async ({ page }) => {
    const id = await memberWithOrder(page);
    await page.goto(`/orders/${id}`);
    await rewriteAggregate(
      page,
      (body) => {
        body.payment = null;
        body.errors = [{ section: 'payment', code: 'UPSTREAM_UNAVAILABLE', retryable: true }];
      },
      page.getByText('Payment details are unavailable right now.'),
    );
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('detail-partial.png', { mask: [page.getByRole('heading', { level: 1 }), page.locator('time')] });
  });
});
