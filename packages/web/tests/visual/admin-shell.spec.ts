import { expect, test, type Page } from '@playwright/test';
import { adminLogin, register } from '../helpers';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';

/**
 * VA rows of W06 (AS-48, AS-59): the admin shell with the drawer closed and open (phone) or the sidebar (desktop), and the
 * no-access panel a member sees, with axe and the width rule on each.
 */

async function expectAccessibleAndContained(page: Page) {
  await expectNoSeriousViolations(page);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  await expectMainFitsWidth(page);
  if (original) await page.setViewportSize(original);
}

test.describe('Admin shell layout', () => {
  test('W06 AS-59 VA shell: sidebar on desktop, top bar and drawer on the phone', async ({ page }) => {
    await adminLogin(page);
    const wide = (page.viewportSize()?.width ?? 1280) >= 1024;
    await expect(page.getByRole('link', { name: 'Back to marketplace' })).toBeVisible();
    if (wide) {
      await expect(page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Feature flags' })).toBeVisible();
    } else {
      const bar = page.getByRole('region', { name: 'Admin bar' });
      await expect(bar.getByRole('button', { name: 'Open menu' })).toBeVisible();
      await expectAccessibleAndContained(page);
      await bar.getByRole('button', { name: 'Open menu' }).click();
      const drawer = page.getByRole('dialog', { name: 'Admin menu' });
      await expect(drawer.getByRole('link', { name: 'Feature flags' })).toHaveAttribute('aria-current', 'page');
      await expectNoSeriousViolations(page);
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(bar.getByRole('button', { name: 'Open menu' })).toBeFocused();
    }
    await expectAccessibleAndContained(page);
  });

  test('W06 AS-48 VA no access: a member sees only the panel', async ({ page }) => {
    await register(page);
    await page.goto('/admin/feature-flags');
    await expect(page.getByRole('heading', { level: 1, name: "You don't have access to this area." })).toBeVisible();
    await expectAccessibleAndContained(page);
  });
});
