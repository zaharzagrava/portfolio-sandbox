import { expect, test } from '@playwright/test';
import { createIsolatedProduct } from './helpers';

/**
 * JE (W02 AS-67, AS-68; gaps H9): a signed-out visitor opens a product page. The browser queues one `product_view` with the
 * product id and its category and sends it to the same-origin `/api/events`, which the BFF forwards to the analytics
 * controller (a `202` proves the forwarding reaches it). Nothing is mocked. The signed-in path is a known follow-up
 * (gaps.md, S48: `sendBeacon` cannot carry the CSRF header).
 */
test.describe('Visitor events', () => {
  test('a product view reaches ingestion', async ({ page }) => {
    test.setTimeout(60_000);
    const product = await createIsolatedProduct();

    const batch = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/events') && (request.postData() ?? '').includes('"product_view"'),
      { timeout: 20_000 },
    );
    await page.goto(`/products/${product.id}?tab=pickup`);
    const request = await batch;
    const response = await request.response();
    expect(response?.status()).toBe(202);

    const { events } = JSON.parse(request.postData()!) as { events: { event_id: string; name: string; anonymous_id: string; page?: string; props?: Record<string, unknown> }[] };
    const views = events.filter((event) => event.name === 'product_view');
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ page: `/products/${product.id}`, props: { product_id: product.id, category: expect.stringMatching(/^[a-z0-9-]{1,40}$/) } });
    expect(views[0]!.anonymous_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(events.every((event) => event.name === 'product_view' || event.name === 'page_view')).toBe(true);

    // The anonymous id is a first-party cookie of one year.
    const cookie = (await page.context().cookies()).find((entry) => entry.name === 'anonymous_id');
    expect(cookie?.value).toBe(views[0]!.anonymous_id);
    expect(cookie?.sameSite).toBe('Lax');
  });

  test('Global Privacy Control: no event is sent and no anonymous id is created', async ({ browser }) => {
    test.setTimeout(60_000);
    const product = await createIsolatedProduct();
    const context = await browser.newContext({ baseURL: 'http://localhost:3000' });
    try {
      await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { configurable: true, get: () => true }));
      const page = await context.newPage();
      let sent = 0;
      page.on('request', (request) => {
        if (request.url().endsWith('/api/events')) sent += 1;
      });
      await page.goto(`/products/${product.id}`);
      await expect(page.getByRole('heading', { level: 1, name: product.title })).toBeVisible();
      await page.waitForTimeout(6_500); // longer than the 5 s flush
      expect(sent).toBe(0);
      expect((await context.cookies()).some((cookie) => cookie.name === 'anonymous_id')).toBe(false);
    } finally {
      await context.close();
    }
  });
});
