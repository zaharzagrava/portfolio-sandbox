import { expect, test, type Page } from '@playwright/test';
import { adminLogin, archiveFlagThroughUi, createFlag, flagPath, uniqueFlagKey } from '../helpers';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';
import { auditPage } from './admin-fixtures';
import { stubApi } from './stubs';

/**
 * VA rows of W06 (AS-40, AS-41, AS-62): the history tab at the phone and desktop widths, with axe and the width rule. The flag
 * is real; the browser's reads of its history are stubbed so the entries are the same on every run.
 */

const created: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unroute('**/*').catch(() => undefined);
  for (const key of created.splice(0)) await archiveFlagThroughUi(page, key).catch(() => undefined);
});

async function expectAccessibleAndContained(page: Page) {
  await expectNoSeriousViolations(page);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  await expectMainFitsWidth(page);
  if (original) await page.setViewportSize(original);
}

test.describe('Admin history layout', () => {
  test('W06 AS-40 AS-41 AS-62 VA history: entries, an expanded entry with long values, paging links', async ({ page }) => {
    await adminLogin(page);
    const key = uniqueFlagKey('vh');
    created.push(key);
    await createFlag(page, key);
    await stubApi(page, 'GET', `/admin/flags/${key}/history`, { body: auditPage(key, 'older-1') });
    await page.goto(flagPath(key, 'history'));
    const entries = page.getByRole('list', { name: 'Change history' }).getByRole('listitem');
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0).getByTestId('action')).toHaveText('Killed');
    await expect(page.getByRole('link', { name: 'Older' })).toBeVisible();
    await expectAccessibleAndContained(page);
    await entries.nth(1).getByRole('button', { name: 'Show changes' }).click();
    await expect(entries.nth(1)).toContainText('Description:');
    await expectAccessibleAndContained(page);
  });
});
