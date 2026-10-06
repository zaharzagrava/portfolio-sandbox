import { test, expect } from '@playwright/test';
import { SEED, login } from './helpers';

/** SD-34 feature flags: an admin creates a flag and pulls its kill switch. */
test.describe('Admin feature flags', () => {
  test('create a flag, then kill it', async ({ page }) => {
    await login(page, SEED.admin, SEED.password, '/admin/feature-flags');

    const key = `e2e-flag-${Date.now()}`;
    await page.getByRole('button', { name: 'Create Flag' }).click();
    await page.getByLabel('Key').fill(key);
    await page.getByLabel('Description').fill('Created by the Playwright journey');
    await page.getByRole('dialog').getByRole('button', { name: /Create/ }).click();

    const row = page.getByTestId('flag-row').filter({ hasText: key });
    await expect(row).toContainText('Enabled');
    await row.getByRole('button', { name: 'Kill Switch' }).click();
    await expect(row).toContainText('Off');
  });
});
