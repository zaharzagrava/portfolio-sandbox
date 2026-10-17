import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openShop, register, shopPath } from '../helpers';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';

/**
 * VA rows of W04 (AS-44, AS-56, AS-65, AS-68, AS-70, AS-73, AS-97): the developer pages at the phone (390 x 844) and desktop
 * (1280 x 800) widths (the `mobile` and `desktop` projects run every test), with axe on every state. The member and the shop
 * are real; the keys and the endpoint are created through the pages themselves. Baselines are committed when the final run
 * produces them.
 */

const stylePath = path.join(__dirname, 'hide-dev-overlay.css');
const content = (page: Page) => page.locator('#main-content');
const HOOK_URL = process.env.WEBHOOK_E2E_URL ?? 'https://example.com/hooks/visual';

async function expectAccessibleAndContained(page: Page) {
  await expectNoSeriousViolations(page);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  await expectMainFitsWidth(page);
  if (original) await page.setViewportSize(original);
}

async function memberWithShop(page: Page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); // "Copy" counts as copied only when the browser allows the write
  await register(page);
  return openShop(page);
}

async function createKey(page: Page, shopId: string, name: string) {
  await page.goto(shopPath(shopId, 'developers/api-keys'));
  await page.getByRole('button', { name: 'Create key' }).first().click();
  const create = page.getByRole('dialog', { name: 'Create key' });
  await create.getByLabel('Name').fill(name);
  await create.getByRole('button', { name: 'Create key' }).click();
  const reveal = page.getByRole('dialog', { name: 'Save your API key' });
  await reveal.getByRole('button', { name: 'Copy' }).click();
  await reveal.getByRole('button', { name: 'Done' }).click();
  await expect(reveal).toBeHidden();
}

test.describe('Seller developers layout', () => {
  test('W04 AS-44 AS-97 VA api keys: empty, then a list with the secret nowhere', async ({ page }) => {
    const { shopId } = await memberWithShop(page);
    await page.goto(shopPath(shopId, 'developers/api-keys'));
    await expect(page.getByText('No API keys yet. Create one to start calling the API.')).toBeVisible();
    await expect(content(page)).toHaveScreenshot('api-keys-empty.png', { stylePath });
    await expectAccessibleAndContained(page);

    await createKey(page, shopId, 'Visual pipeline');
    await expect(page.getByRole('row').filter({ hasText: 'Visual pipeline' })).toContainText('Active');
    await expect(content(page)).toHaveScreenshot('api-keys-list.png', { stylePath, mask: [page.locator('time')] });
    await expectAccessibleAndContained(page);
  });

  test('W04 AS-56 AS-97 VA webhooks list: empty and the add dialog', async ({ page }) => {
    const { shopId } = await memberWithShop(page);
    await page.goto(shopPath(shopId, 'developers/webhooks'));
    await expect(page.getByText('No webhook endpoints yet. Add one to receive events.')).toBeVisible();
    await expect(content(page)).toHaveScreenshot('webhooks-empty.png', { stylePath });
    await expectAccessibleAndContained(page);

    await page.getByRole('button', { name: 'Add endpoint' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add endpoint' });
    await expect(dialog.getByRole('checkbox').first()).toBeVisible();
    await expect(dialog).toHaveScreenshot('webhooks-add.png', { stylePath });
    await expectNoSeriousViolations(page);
  });

  test('W04 AS-65 AS-97 VA deliveries: an endpoint with no deliveries yet', async ({ page }) => {
    const { shopId } = await memberWithShop(page);
    await page.goto(shopPath(shopId, 'developers/webhooks'));
    await page.getByRole('button', { name: 'Add endpoint' }).first().click();
    const add = page.getByRole('dialog', { name: 'Add endpoint' });
    await add.getByLabel('Endpoint URL').fill(HOOK_URL);
    await expect(add.getByRole('checkbox').first()).toBeVisible();
    await add.getByRole('button', { name: 'Add endpoint' }).click();
    const reveal = page.getByRole('dialog', { name: 'Webhook signing secret' });
    // a refused URL fails this test: set WEBHOOK_E2E_URL to an accepted one (S43 FR-041, L-003)
    await expect(reveal).toBeVisible();
    await reveal.getByRole('button', { name: 'Copy' }).click();
    await reveal.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('link', { name: HOOK_URL }).click();
    await expect(page.getByText('No deliveries in the last 30 days.')).toBeVisible();
    await expect(content(page)).toHaveScreenshot('deliveries-empty.png', { stylePath, mask: [page.locator('time')] });
    await expectAccessibleAndContained(page);
  });

  test('W04 AS-68 AS-97 VA api version: the pin and the supported versions', async ({ page }) => {
    const { shopId } = await memberWithShop(page);
    await page.goto(shopPath(shopId, 'developers/api-version'));
    await expect(page.getByRole('heading', { level: 1, name: 'API version' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Supported versions' })).toBeVisible();
    await expect(content(page)).toHaveScreenshot('api-version.png', { stylePath, mask: [page.locator('time')] });
    await expectAccessibleAndContained(page);
  });

  test('W04 AS-70 AS-97 VA request logs: filters and the empty result', async ({ page }) => {
    const { shopId } = await memberWithShop(page);
    await page.goto(shopPath(shopId, 'developers/logs'));
    await expect(page.getByText('No matching requests.')).toBeVisible();
    await expect(content(page)).toHaveScreenshot('logs-empty.png', { stylePath });
    await expectAccessibleAndContained(page);
  });

  test('W04 AS-73 AS-97 VA usage: the period, the mode and the empty report', async ({ page }) => {
    const { shopId } = await memberWithShop(page);
    await page.goto(shopPath(shopId, 'developers/usage'));
    await expect(page.getByText('No API calls in this period.')).toBeVisible();
    await expect(content(page)).toHaveScreenshot('usage-empty.png', { stylePath });
    await expectAccessibleAndContained(page);
  });
});
