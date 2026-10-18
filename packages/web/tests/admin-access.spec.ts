import { expect, test } from '@playwright/test';
import { SEED, adminLogin, login, register } from './helpers';

/** W06 AS-47, AS-48: only admins get into the console; a visitor signs in and comes back, a member sees only the no-access panel. */
test.describe('Admin console access', () => {
  test('W06 AS-47 an anonymous visitor is sent to sign in and returns to the console', async ({ page }) => {
    await page.goto('/admin/feature-flags?status=killed');
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fadmin%2Ffeature-flags%3Fstatus%3Dkilled/);
    await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
    await login(page, SEED.admin, SEED.password, '/admin/feature-flags?status=killed');
    await expect(page.getByRole('heading', { level: 1, name: 'Feature flags' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Killed' })).toHaveAttribute('aria-selected', 'true');
  });

  test('W06 AS-48 AS-59 an admin sees the shell and the navigation', async ({ page }) => {
    await adminLogin(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Feature flags' })).toBeVisible();
    await expect(page.locator('main > div > header').getByText(SEED.admin)).toBeVisible();
    const viewport = page.viewportSize();
    if (viewport && viewport.width < 1024) {
      await page.getByRole('button', { name: 'Open menu', exact: true }).last().click();
      await expect(page.getByRole('dialog').getByRole('link', { name: 'Feature flags' })).toHaveAttribute('aria-current', 'page');
    } else {
      await expect(page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Feature flags' })).toHaveAttribute('aria-current', 'page');
    }
  });

  test('W06 AS-48 a member who is not an admin sees only the no-access panel', async ({ page }) => {
    await register(page);
    await page.goto('/admin/feature-flags');
    await expect(page.getByRole('heading', { level: 1, name: "You don't have access to this area." })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to marketplace' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
    await expect(page.getByRole('table')).toHaveCount(0);
    await page.goto('/admin/feature-flags/anything-at-all');
    await expect(page.getByRole('heading', { level: 1, name: "You don't have access to this area." })).toBeVisible();
  });
});
