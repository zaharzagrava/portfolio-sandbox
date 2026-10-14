import { expect, test } from '@playwright/test';
import { login, register } from './helpers';

/** JS (W01 AS-54..AS-56): see my devices, sign one out, sign out everywhere. */
test.describe('Active sessions', () => {
  test('see my devices, sign one out, sign out everywhere', async ({ page, browser }) => {
    const { email, password } = await register(page);

    const otherContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const other = await otherContext.newPage();
    try {
      await login(other, email, password);

      await page.goto('/account/security?tab=sessions');
      // Cards (phone) are list items, the desktop layout is a table: either way one row per session.
      const rows = page.locator('#main-content').locator('li, tbody tr');
      await expect(page.getByText('This device')).toHaveCount(1);
      const here = rows.filter({ hasText: 'This device' });
      const elsewhere = rows.filter({ hasNotText: 'This device' });
      await expect(rows).toHaveCount(2);
      await expect(here.getByRole('button')).toHaveCount(0);

      await elsewhere.getByRole('button', { name: /^Log out/ }).click();
      await expect(rows).toHaveCount(1);
      await expect(page.getByRole('status').filter({ hasText: 'Device signed out.' })).toBeAttached();

      // The revoked device is signed out on its next request.
      // (The BFF's own session check is local, so the server guard still passes; the first API call answers 401 and the
      // session-ended flow of AS-26 runs. See gaps.md "Sibling-spec follow-ups" for S48.)
      await other.goto('/account/security');
      await expect(other.getByText('Your session ended. Sign in again to continue.')).toBeVisible();
      await expect(other.getByRole('link', { name: 'Log in' })).toBeVisible();

      await page.getByRole('button', { name: 'Log out of all devices' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('This signs you out here too.');
      await dialog.getByRole('button', { name: 'Log out everywhere' }).click();
      await expect(page).toHaveURL('http://localhost:3000/login?notice=signed_out_everywhere');
      await expect(page.getByRole('status').filter({ hasText: "You've been signed out on all devices." })).toBeVisible();
    } finally {
      await otherContext.close();
    }
  });
});
