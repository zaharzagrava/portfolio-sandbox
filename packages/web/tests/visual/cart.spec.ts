import { expect, test, type Page } from '@playwright/test';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';

/**
 * VC rows of W03 (AS-74, SC-008): the cart page's layout states at the phone (390 x 844) and desktop (1280 x 800) widths.
 * The cart aggregate (`GET /api/bff/cart`) is stubbed so each state is exact; the page is a static shell and the guest
 * session probe answers "anonymous" by itself.
 */

type Line = {
  productId: string;
  quantity: number;
  addedAt: string;
  product: { title: string; priceMinor: number; currency: string; imageUrl: string | null; inStock: boolean } | null;
  shop: { id: string; name: string } | null;
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const line = (n: number, over: Partial<Line> = {}): Line => ({
  productId: uuid(n),
  quantity: 1,
  addedAt: '2026-10-01T10:00:00.000Z',
  product: { title: `Product number ${n}`, priceMinor: 1999 * n, currency: 'USD', imageUrl: null, inStock: true },
  shop: { id: uuid(900 + (n % 2)), name: `Shop ${n % 2}` },
  ...over,
});

async function stubCart(page: Page, body: unknown, status = 200) {
  await page.route('**/api/bff/cart', async (route) => {
    await route.fulfill({ status, contentType: status === 200 ? 'application/json' : 'application/problem+json', body: JSON.stringify(body) });
  });
  await page.route('**/api/cart', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lines: [] }) }));
}

test.describe('Cart layout', () => {
  test('empty', async ({ page }) => {
    await stubCart(page, { lines: [], droppedLines: 0, errors: [] });
    await page.goto('/cart');
    await expect(page.getByText('Your cart is empty')).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('empty.png');
  });

  test('loaded', async ({ page }) => {
    await stubCart(page, { lines: [line(1, { quantity: 2 }), line(2), line(3)], droppedLines: 0, errors: [] });
    await page.goto('/cart');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Product number 1').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Sold by/ }).first()).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('loaded.png');
  });

  test('loading', async ({ page }) => {
    await page.route('**/api/cart', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lines: [] }) }));
    await page.route('**/api/bff/cart', () => new Promise(() => undefined)); // never answers
    await page.goto('/cart');
    await expect(page.getByRole('status').first()).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('loading.png');
  });

  test('error', async ({ page }) => {
    await stubCart(page, { type: 'about:blank', title: 'Service unavailable', status: 503, code: 'service_unavailable' }, 503);
    await page.goto('/cart');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('error.png');
  });

  test('partial', async ({ page }) => {
    const lines = [line(1, { product: null, shop: null }), line(2, { product: null, shop: null })];
    await stubCart(page, { lines, droppedLines: 0, errors: [{ section: 'products', code: 'UPSTREAM_UNAVAILABLE', retryable: true }] });
    await page.goto('/cart');
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('partial.png');
  });

  test('unavailable-lines', async ({ page }) => {
    const lines = [line(1), line(2, { product: { title: 'Out of stock thing', priceMinor: 500, currency: 'USD', imageUrl: null, inStock: false } }), line(3, { product: null })];
    await stubCart(page, { lines, droppedLines: 1, errors: [] });
    await page.goto('/cart');
    await expect(page.getByText('Out of stock thing').first()).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('unavailable-lines.png');
  });

  test('50 lines of 20 units and long titles: no horizontal scroll at 320 px', async ({ page }) => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      line(i + 1, {
        quantity: 20,
        product: { title: `A very long product title that keeps going and going without any space ${'x'.repeat(60)} ${i}`, priceMinor: 123456789, currency: 'USD', imageUrl: null, inStock: true },
      }),
    );
    await stubCart(page, { lines, droppedLines: 0, errors: [] });
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/cart');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(/^A very long product title/).first()).toBeVisible();
    // W07's header is 29 px wider than 320 px (gaps.md "Sibling-spec follow-ups"); it widens the layout viewport and would
    // hide W03's own overflow, so it is taken out of the measurement.
    await page.addStyleTag({ content: 'header { display: none !important; }' });
    await expectMainFitsWidth(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});
