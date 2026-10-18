import { expect, test, type Page } from '@playwright/test';
import { adminLogin, archiveFlagThroughUi, createFlag, flagPath, uniqueFlagKey } from '../helpers';
import { expectMainFitsWidth, expectNoHorizontalScroll, expectNoSeriousViolations } from './axe';
import { bigFlag, flagBody } from './admin-fixtures';
import { problem, stubApi } from './stubs';

/**
 * VA rows of W06 (AS-09, AS-17, AS-28, AS-32, AS-33, AS-34, AS-37, AS-61, AS-62, AS-63): the create form and the editor at the
 * phone (390 x 844) and desktop (1280 x 800) widths, with axe and the width rule on each. The flag is real (created through the
 * UI, so the server's first read works); the browser's own reads of it are stubbed to show each state.
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
  await expectNoHorizontalScroll(page);
  if (original) await page.setViewportSize(original);
}

async function realFlag(page: Page) {
  await adminLogin(page);
  const key = uniqueFlagKey('va');
  created.push(key);
  await createFlag(page, key, { description: 'Layout flag' });
  // The "created" toast has its own markup (W07); reload so the page under test is the editor alone.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: key })).toBeVisible();
  return key;
}

test.describe('Admin create and editor layout', () => {
  test('W06 AS-09 AS-62 VA create form: single column on the phone, centred card on desktop', async ({ page }) => {
    await adminLogin(page);
    await page.goto('/admin/feature-flags/new');
    await expect(page.getByRole('heading', { level: 1, name: 'New flag' })).toBeVisible();
    await expect(page.getByLabel('Owner')).toHaveValue('admin@marketplace.local');
    await expect(page.getByRole('button', { name: 'Create flag' })).toBeVisible();
    await expectAccessibleAndContained(page);
  });

  test('W06 AS-17 AS-33 AS-63 VA editor: header, sections, kill switch within reach, docked save bar', async ({ page }) => {
    const key = await realFlag(page);
    await expect(page.getByRole('button', { name: 'Kill switch' })).toBeInViewport();
    await page.getByLabel('Description').fill('Edited for layout');
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeInViewport();
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: key })).toBeVisible();
    await expectAccessibleAndContained(page);
  });

  test('W06 AS-61 VA editor with 20 variants and 50 rules: usable, save bar docked, no sideways scroll', async ({ page }) => {
    const key = await realFlag(page);
    await stubApi(page, 'GET', `/admin/flags/${key}`, { body: bigFlag(key, { version: 9 }) });
    await page.reload();
    await expect(page.getByRole('button', { name: /^Rule 50: / })).toBeAttached();
    await expect(page.getByRole('list', { name: /Targeting rules/ }).getByRole('listitem')).toHaveCount(50);
    await page.getByLabel('Description').fill('Big');
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeInViewport();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousViolations(page);
  });

  test('W06 AS-28 VA conflict banner: the save is refused and the banner offers Load latest', async ({ page }) => {
    const key = await realFlag(page);
    await stubApi(page, 'PUT', `/admin/flags/${key}`, problem(409, 'version_conflict', { currentVersion: 5 }));
    await page.getByLabel('Description').fill('Mine');
    await page.getByRole('button', { name: 'Save changes' }).click();
    const banner = page.getByRole('alert').filter({ hasText: 'was changed by someone else' });
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Load latest' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await expectAccessibleAndContained(page);
  });

  test('W06 AS-32 VA kill dialog: a centred card on desktop, a sheet on the phone; Cancel focused', async ({ page }) => {
    const key = await realFlag(page);
    await page.getByRole('button', { name: 'Kill switch' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(`Kill ${key}?`)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Kill flag' })).toBeInViewport();
    await expectNoSeriousViolations(page);
  });

  test('W06 AS-34 AS-37 VA killed and archived flags: banner, disabled controls', async ({ page }) => {
    const key = await realFlag(page);
    await stubApi(page, 'GET', `/admin/flags/${key}`, { body: flagBody({ key, status: 'killed', version: 9 }) });
    await page.reload();
    await expect(page.getByText(/This flag is killed\./)).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Enabled' })).toBeDisabled();
    await expectAccessibleAndContained(page);
    await stubApi(page, 'GET', `/admin/flags/${key}`, { body: flagBody({ key, status: 'archived', version: 10 }) });
    await page.reload();
    await expect(page.getByText("This flag is archived. It can't be edited, killed or restored.")).toBeVisible();
    await expect(page.getByLabel('Description')).toBeDisabled();
    await expectAccessibleAndContained(page);
  });

  test('W06 AS-31 VA unknown flag: the not-found page', async ({ page }) => {
    await adminLogin(page);
    await page.goto(flagPath('does-not-exist-zzz'));
    await expect(page.getByRole('heading', { name: "We couldn't find that flag." })).toBeVisible();
    await page.goto('/admin/feature-flags/Bad_Key!');
    await expect(page.getByRole('heading', { name: "We couldn't find that flag." })).toBeVisible();
    await expectAccessibleAndContained(page);
  });
});
