import { test, expect, type Page } from '@playwright/test';
import { closeMenu, openMenuIfCollapsed, resetRateLimits } from './helpers';

// At desktop width the account control is a button in the header; on the phone it is the entries of the menu.
const phone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

/** SD-39 happy path against the real backend (D27: UI journeys = happy paths; edge cases live in the API e2e suite). */
test.describe('Authentication', () => {
  test('register, stay signed in across a reload, log out, log back in', async ({ page }) => {
    const expectSignedIn = async () => {
      if (!phone(page)) {
        await expect(account).toBeVisible();
        await expect(page.getByRole('link', { name: 'Log in' })).toHaveCount(0);
        return;
      }
      await openMenuIfCollapsed(page);
      await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Log in' })).toHaveCount(0);
      await closeMenu(page);
    };
    const logOut = async () => {
      if (!phone(page)) {
        await account.click();
        return page.getByRole('menuitem', { name: 'Log out' }).click();
      }
      await openMenuIfCollapsed(page);
      await page.getByRole('button', { name: 'Log out' }).click();
    };
    const email = `ui-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const password = 'SuperSecurePassword123!';
    const account = page.getByRole('button', { name: email.split('@')[0].slice(0, 2).toUpperCase() });

    await resetRateLimits(); // register is limited to 10/hour per address; a full run registers more often
    await page.goto('/register');
    await page.fill('input[name="name"]', 'UI Test User');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="confirmPassword"]', password);
    await page.locator('button[id="terms"]').click();
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL('http://localhost:3000/');
    await expectSignedIn();

    // The access token lives in memory; the HttpOnly refresh cookie must restore the session.
    await page.reload();
    await expectSignedIn();

    await logOut();
    await expect(page).toHaveURL(/\/login/);

    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('http://localhost:3000/');
    await expectSignedIn();
  });
});
