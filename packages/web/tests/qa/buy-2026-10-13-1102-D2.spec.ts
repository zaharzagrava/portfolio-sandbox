import { test, expect } from '@playwright/test';
import { createIsolatedProduct } from '../helpers';

test('QA-buy-2026-10-13-1102-D2: clicking a product in the search results sends a click event the API accepts (2xx)', async ({ page }) => {
  const { title } = await createIsolatedProduct();
  await page.goto(`/search?q=${encodeURIComponent(title)}`);
  const card = page.getByTestId('product-card').filter({ hasText: title }).first();
  await expect(card).toBeVisible();

  const clickResponse = page.waitForResponse((res) => res.url().includes('/api/search/clicks') && res.request().method() === 'POST');
  await card.click();

  const res = await clickResponse;
  expect(res.status()).toBeLessThan(300);
});
