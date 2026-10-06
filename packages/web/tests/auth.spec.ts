import { test, expect } from '@playwright/test';

/** SD-39 happy path against the real backend (D27: UI journeys = happy paths; edge cases live in the API e2e suite). */
test.describe('Authentication', () => {
  test('register, stay signed in across a reload, log out, log back in', async ({ page }) => {
    const email = `ui-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const password = 'SuperSecurePassword123!';
    const account = page.getByRole('button', { name: email.split('@')[0].slice(0, 2).toUpperCase() });

    await page.goto('/register');
    await page.fill('input[name="name"]', 'UI Test User');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="confirmPassword"]', password);
    await page.locator('button[id="terms"]').click();
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL('http://localhost:3000/');
    await expect(account).toBeVisible();

    // The access token lives in memory; the HttpOnly refresh cookie must restore the session.
    await page.reload();
    await expect(account).toBeVisible();

    await account.click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('http://localhost:3000/');
    await expect(account).toBeVisible();
  });
});
