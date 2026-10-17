import { test, expect } from '@playwright/test';
import { API_URL, productId } from './helpers';

/**
 * Home's "Trending now" rail (S35 AS-41, T56). Trending is built from product views that went through the real event
 * ingestion, so the journey sends a few and waits for the rail's API to show them. When the stack's trending window does
 * not fill (no S35 on-demand dataset hook yet, gaps B-6 / H5), the journey is marked fixme instead of failing.
 */
test.describe('Home trending', () => {
  test('trending card links to the product, prices are formatted, no implementation note', async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await productId();
    const trending = async () => {
      const res = await request.get(`${API_URL}/api/trending?limit=8`);
      return res.ok() ? ((await res.json()) as { items: { productId: string }[] }).items : [];
    };

    let items = await trending();
    if (items.length === 0) {
      const views = Array.from({ length: 6 }, (_, i) => ({
        event_id: crypto.randomUUID(),
        name: 'product_view',
        anonymous_id: `trend-journey-${Date.now()}-${i}`,
        ts: Date.now(),
        props: { product_id: id, category: 'kitchen' },
      }));
      const sent = await request.post(`${API_URL}/api/events`, { data: { events: views } });
      expect(sent.status()).toBe(202);
      // The window closes on a watermark, so the rail fills a little later.
      for (let attempt = 0; attempt < 90 && items.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        items = await trending();
      }
    }
    test.fixme(items.length === 0, 'the trending window does not fill on demand: S35 dataset T hook missing (questions.md Q-W02-2)');

    const rail = page.getByTestId('home-products');
    // The home page reads trending through a short cache, and shows the catalogue's first products until it holds the ranking: reload until
    // the trending cards (test id rail-card) are on the page. Waiting on a page that was already rendered would never see them.
    await expect(async () => {
      await page.goto('/');
      await expect(rail.getByTestId('rail-card').first()).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 90_000, intervals: [2_000, 5_000] });
    const card = rail.getByRole('link').first();
    await expect(card).toHaveAttribute('href', /^\/products\/[0-9a-f-]{36}$/);
    await expect(card).toContainText(/€\d[\d,]*\.\d{2}/);
    await expect(page.getByText(/Powered by|Count-Min Sketch/i)).toHaveCount(0);
    await card.click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
  });
});
