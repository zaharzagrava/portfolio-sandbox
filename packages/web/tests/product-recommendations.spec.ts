import { test, expect } from '@playwright/test';
import { API_URL, productWithRecommendations } from './helpers';

/** S34 AS-48 / A25: the product page renders the new recommendation shape (`{type, items}`, `priceMinor` + `currency`). */
test.describe('Product recommendations', () => {
  test('frequently bought together renders money from priceMinor and currency, and hides when empty', async ({ page, request }) => {
    const found = await productWithRecommendations(request);
    test.fixme(!found, 'S34 dataset D (bought together) is not seeded in the dev stack (questions.md Q-W02-3)');
    await page.goto(`/products/${found!.id}`);
    const rail = page.getByRole('region', { name: 'Frequently bought together' });
    await expect(rail).toBeVisible();
    await expect(rail.getByTestId('rail-card').first()).toContainText(/[$€£]\d/);
  });

  test('a product without recommendations shows no empty heading', async ({ page, request }) => {
    const list = await request.get(`${API_URL}/api/products/search?q=espresso&limit=20`);
    const { items } = (await list.json()) as { items: { id: string }[] };
    let bareId: string | undefined;
    for (const item of items) {
      const rec = await request.get(`${API_URL}/api/products/${item.id}/recommendations`);
      const body = rec.ok() ? ((await rec.json()) as { items?: unknown[] }) : {};
      if (!body.items?.length) {
        bareId = item.id;
        break;
      }
    }
    expect(bareId, 'the dev catalogue has a product without recommendations').toBeDefined();
    await page.goto(`/products/${bareId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Frequently bought together')).toHaveCount(0);
  });
});
