import { test, expect } from '@playwright/test';
import { register } from './helpers';

/** Seller onboarding (SD-02), inventory (SD-37 shop search), developer platform (SD-07 keys, webhooks). */
test.describe('Seller', () => {
  test('a buyer opens a shop, adds a product, creates an API key and a webhook', async ({ page }) => {
    await register(page);
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Start selling' }).click();

    const shopName = `E2E Shop ${Date.now()}`;
    await page.getByLabel('Shop name').fill(shopName);
    await page.getByRole('button', { name: 'Open shop' }).click();
    await expect(page.getByTestId('seller-shop-name')).toHaveText(shopName);

    // Inventory: create a product, then find it again with a typo.
    await page.getByRole('link', { name: 'Inventory' }).first().click();
    await expect(page.getByTestId('inventory-empty')).toBeVisible();
    await page.getByRole('button', { name: 'Add Product' }).click();
    await page.getByLabel('Title').fill('Handmade Ceramic Mug');
    await page.getByLabel('Brand').fill('ClayWorks');
    await page.getByLabel('Category').fill('kitchen');
    await page.getByLabel('Price (USD)').fill('24.50');
    await page.getByLabel('Stock').fill('3');
    await page.getByRole('button', { name: 'Create product' }).click();
    const row = page.getByTestId('inventory-row').filter({ hasText: 'Handmade Ceramic Mug' });
    await expect(row).toContainText('$24.50');
    await expect(row).toContainText('Low stock');
    await page.getByLabel('Search your products').fill('ceramc mug');
    await expect(page.getByTestId('inventory-row')).toHaveCount(1);

    // API key: shown once, listed by prefix afterwards.
    await page.getByRole('link', { name: 'API Keys' }).click();
    await page.getByRole('button', { name: 'Generate Key' }).click();
    await page.getByLabel('Key Name').fill('CI integration');
    await page.getByRole('dialog').getByRole('button', { name: 'Generate Key' }).click();
    await expect(page.getByRole('dialog').locator('input[readonly]')).toHaveValue(/^sk_test_/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('api-key-row')).toContainText('CI integration');

    // Webhook endpoint: the signing secret is shown once.
    await page.getByRole('link', { name: 'Webhooks' }).click();
    await page.getByRole('button', { name: /Add Endpoint/i }).first().click();
    await page.getByLabel('Endpoint URL').fill('https://example.com/hooks/marketplace');
    await page.getByRole('dialog').getByRole('button', { name: 'Add Endpoint' }).click();
    await expect(page.getByRole('dialog').locator('input[readonly]')).toHaveValue(/^whsec_/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('https://example.com/hooks/marketplace')).toBeVisible();
  });
});
