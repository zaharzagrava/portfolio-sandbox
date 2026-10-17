import { expect, test } from '@playwright/test';
import { register, resetRateLimits } from './helpers';

/** W04 seller entry smoke: a new member opens a shop and lands on its overview. The detailed journeys are in seller-shop.spec.ts and the other seller-*.spec.ts files. */
test.describe('Seller', () => {
  test('W04 AS-01: a buyer opens a shop and sees its name on the overview', async ({ page }) => {
    await register(page);
    await resetRateLimits();
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Start selling' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
    const shopName = `E2E Shop ${Date.now().toString(36)}`;
    await page.getByLabel('Shop name').fill(shopName);
    await page.getByRole('button', { name: 'Open shop' }).click();
    await expect(page).toHaveURL(/\/dashboard\/seller\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: shopName })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Last 60 seconds' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Today (UTC)' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Leaderboard rank' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Top products' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Seller' }).getByRole('link', { name: 'Inventory' })).toBeVisible();
  });
});
