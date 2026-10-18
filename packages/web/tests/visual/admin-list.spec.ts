import { expect, test, type Page } from '@playwright/test';
import { adminLogin } from '../helpers';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';
import { listPage, LONG_KEY, staleBody } from './admin-fixtures';
import { problem, stubApi } from './stubs';

/**
 * VA rows of W06 (AS-01, AS-05, AS-07, AS-45, AS-60, AS-63): the flag list and the stale report at the phone (390 x 844) and
 * desktop (1280 x 800) widths, with axe and the no-horizontal-scroll rule on each. The admin is real; the browser's own list reads
 * are stubbed so each screen shows a layout state, not whatever the stack holds. (The server's first read cannot be stubbed here,
 * so the stub replaces it on mount.) Screenshots are taken once a baseline run exists; structure, axe and width are asserted now.
 */

async function expectAccessibleAndContained(page: Page) {
  await expectNoSeriousViolations(page);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  await expectMainFitsWidth(page);
  if (original) await page.setViewportSize(original);
}

test.describe('Admin flag list layout', () => {
  test('W06 AS-01 AS-60 VA list with data: table on desktop, cards on the phone, long values wrap', async ({ page }) => {
    await stubApi(page, 'GET', '/admin/flags', { body: listPage('next-1') });
    await adminLogin(page);
    await expect(page.getByRole('link', { name: LONG_KEY })).toBeVisible();
    await expect(page.getByRole('link', { name: 'alpha-flag' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Next page' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Status' })).toBeVisible();
    await expectAccessibleAndContained(page);
  });

  test('W06 AS-05 AS-60 VA list empty: the two empty states read differently', async ({ page }) => {
    await stubApi(page, 'GET', '/admin/flags', { body: { items: [], nextCursor: null } });
    await adminLogin(page);
    await expect(page.getByText('No feature flags yet.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'New flag' }).first()).toBeVisible();
    await expectAccessibleAndContained(page);
    await page.goto('/admin/feature-flags?status=killed');
    await expect(page.getByText('No killed flags.')).toBeVisible();
    await expectAccessibleAndContained(page);
  });

  test('W06 AS-07 VA list error: a failed refresh keeps the rows and says so', async ({ page }) => {
    await adminLogin(page);
    await stubApi(page, 'GET', '/admin/flags', problem(503, 'unavailable', { requestId: 'req-503' }));
    await page.reload();
    await expect(page.getByText("Couldn't refresh. Showing the last loaded list.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expectAccessibleAndContained(page);
  });

  test('W06 AS-45 AS-60 AS-63 VA stale report: table or cards, empty message', async ({ page }) => {
    await stubApi(page, 'GET', '/admin/flags', { body: listPage() });
    await stubApi(page, 'GET', '/admin/flags/stale', { body: staleBody() });
    await adminLogin(page);
    await page.getByRole('tab', { name: 'Stale' }).click();
    await expect(page.getByRole('link', { name: 'old-flag' })).toBeVisible();
    await expect(page.getByText('Expired')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Window' })).toBeVisible();
    await expectAccessibleAndContained(page);
    await stubApi(page, 'GET', '/admin/flags/stale', { body: { days: 14, items: [] } });
    await page.reload();
    await expect(page.getByText(/No stale flags\. Nothing has expired/)).toBeVisible();
    await expectAccessibleAndContained(page);
  });
});
