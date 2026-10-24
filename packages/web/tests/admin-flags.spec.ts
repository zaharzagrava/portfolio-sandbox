import { expect, test, type Page } from '@playwright/test';
import { archiveFlagThroughUi, createFlag, flagPath, uniqueFlagKey } from './helpers';
import { adminLoginByApi } from './seller-setup';

/**
 * W06 journeys (VII.7: the happy path of each story; every failure form is a unit test): an admin creates a flag that starts
 * dark, ramps it, kills / restores / archives it, reads the audit trail and opens the stale report. Test flags are archived at
 * the end so the stack's 500-flag limit is not used up; their keys sort first (see `uniqueFlagKey`).
 */
const created: string[] = [];

test.afterEach(async ({ page }) => {
  for (const key of created.splice(0)) await archiveFlagThroughUi(page, key).catch(() => undefined);
});

async function newFlag(page: Page, description?: string) {
  await adminLoginByApi(page);
  const key = uniqueFlagKey();
  created.push(key);
  await createFlag(page, key, { description });
  return key;
}

test.describe('Admin feature flags', () => {
  test('W06 AS-09 AS-11 admin creates a dark flag', async ({ page }) => {
    const key = await newFlag(page);
    await expect(page.locator('header').filter({ hasText: key })).toContainText('Disabled');
    await expect(page.locator('header').filter({ hasText: key })).toContainText('Version 1');
    await expect(page.getByText(/This flag is disabled: everyone gets the off variant\./)).toBeVisible();
    await page.goto('/admin/feature-flags');
    const row = page.getByRole('row').filter({ hasText: key });
    await expect(row).toContainText('Disabled');
    await expect(row.getByRole('link', { name: key })).toBeVisible();
  });

  test('W06 AS-17 AS-18 AS-21 AS-23 AS-24 admin ramps a flag', async ({ page }) => {
    const key = await newFlag(page, 'Journey flag');
    await expect(page.getByRole('group', { name: 'Variants', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Targeting rules' })).toBeVisible();

    await page.getByLabel('Description').fill('Journey flag, ramped');
    await page.getByLabel('Client-side').check();
    await page.getByRole('button', { name: 'Add rule' }).click();
    const rule = page.getByRole('group', { name: /^Rule 1\b/ });
    await rule.getByRole('button', { name: 'Add condition' }).click();
    await rule.getByLabel('Attribute').selectOption('email_domain');
    await rule.getByLabel('Values').fill('example.com');
    await rule.getByRole('radio', { name: 'Percentage rollout' }).check();
    await rule.getByLabel('Variant', { exact: true }).first().selectOption('on');
    await rule.getByLabel('Weight (%)').first().fill('5');
    await rule.getByRole('button', { name: 'Add slice' }).click();
    await rule.getByRole('button', { name: 'Make the last slice the remainder' }).click();
    await expect(rule.getByText('Total: 100%')).toBeVisible();
    await page.getByRole('switch', { name: 'Enabled' }).click();

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await expect(page.locator('header').filter({ hasText: key })).toContainText('Version 2');
    await expect(page.locator('header').filter({ hasText: key })).toContainText('Enabled');

    await page.reload();
    await expect(page.getByLabel('Description')).toHaveValue('Journey flag, ramped');
    await expect(page.getByLabel('Client-side')).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Enabled' })).toBeChecked();
    const reloaded = page.getByRole('group', { name: /^Rule 1\b/ });
    await expect(reloaded.getByLabel('Weight (%)').first()).toHaveValue('5');
    await expect(reloaded.getByLabel('Weight (%)').nth(1)).toHaveValue('95');
  });

  test('W06 AS-08 AS-32 AS-34 AS-36 AS-37 admin kills, restores and archives a flag', async ({ page }) => {
    const key = await newFlag(page);
    await page.goto('/admin/feature-flags');
    const row = page.getByRole('row').filter({ hasText: key });
    await row.getByRole('button', { name: `Actions for ${key}` }).click();
    await page.getByRole('menuitem', { name: 'Kill switch' }).click();
    const kill = page.getByRole('dialog');
    await expect(kill.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await kill.getByRole('button', { name: 'Kill flag' }).click();
    await expect(page.getByRole('row').filter({ hasText: key })).toContainText('Killed');

    await page.goto(flagPath(key));
    await expect(page.getByText(/This flag is killed\./)).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Enabled' })).toBeDisabled();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Restore flag' }).click();
    await expect(page.locator('header').filter({ hasText: key })).toContainText('Disabled');

    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Archive flag' }).click();
    await expect(page.getByText("This flag is archived. It can't be edited, killed or restored.")).toBeVisible();
    await expect(page.getByLabel('Description')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Kill switch' })).toHaveCount(0);
  });

  test('W06 AS-40 AS-44 admin reads the audit trail', async ({ page }) => {
    const key = await newFlag(page);
    await page.getByLabel('Description').fill('Trail');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.getByRole('button', { name: 'Kill switch' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Kill flag' }).click();
    await expect(page.locator('header').filter({ hasText: key })).toContainText('Killed');

    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/feature-flags/${key}\\?tab=history`));
    const entries = page.getByRole('list', { name: 'Change history' }).getByRole('listitem');
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0).getByTestId('action')).toHaveText('Killed');
    await expect(entries.nth(1).getByTestId('action')).toHaveText('Updated');
    await expect(entries.nth(2).getByTestId('action')).toHaveText('Created');
    await expect(entries.first()).toContainText('You');
    await entries.first().getByRole('button', { name: 'Show changes' }).click();
    await expect(entries.first()).toContainText('Status: Disabled → Killed');
  });

  test('W06 AS-45 admin opens the stale report', async ({ page }) => {
    await adminLoginByApi(page);
    await page.getByRole('tab', { name: 'Stale' }).click();
    await expect(page).toHaveURL(/tab=stale/);
    // The dev stack seeds no expired or unused flag (gaps E9): the report or its good-news message must show.
    await expect(page.getByRole('table', { name: 'Stale flags' }).or(page.getByText(/No stale flags\. Nothing has expired/))).toBeVisible();
  });
});
