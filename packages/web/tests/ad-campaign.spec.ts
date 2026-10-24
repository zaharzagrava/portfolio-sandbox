import { expect, test } from '@playwright/test';
import { register, seedProduct, shopPath } from './helpers';
import { openShopByApi } from './seller-setup';

/**
 * W04 journey "sponsored campaign" (F7): the owner of a fresh shop creates a campaign for one of its products
 * and pauses it. The shop and the product are the member's own (L-005, L-006). The browser run belongs to the final
 * checkpoint; this file is only written with the task.
 */
const TITLE = 'Sponsored Walnut Spoon';

test.describe('Seller campaigns', () => {
  test('owner creates a campaign and pauses it', async ({ page }) => {
    const member = const member = await register(page);
    const { shopId } = await openShopByApi(member);
    await seedProduct(shopId, { title: TITLE, quantity: 8 }, member);

    await page.goto(shopPath(shopId, 'campaigns'));
    await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
    await expect(page.getByText('No campaigns yet.')).toBeVisible();

    await page.getByRole('button', { name: 'Create campaign' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create campaign' });
    await dialog.getByLabel('Product').selectOption({ label: TITLE });
    await dialog.getByLabel('Cost per click (EUR)').fill('0.25');
    await dialog.getByLabel('Daily budget (EUR)').fill('15');
    await dialog.getByRole('button', { name: 'Create campaign' }).click();
    await expect(dialog).toBeHidden();

    const row = page.getByRole('row').filter({ hasText: TITLE });
    await expect(row).toContainText('Active');
    await expect(row).toContainText('€0.25');
    await expect(row).toContainText('€15.00');

    await page.getByRole('button', { name: `Actions for ${TITLE}` }).click();
    await page.getByRole('menuitem', { name: 'Pause' }).click();
    await expect(row).toContainText('Paused');
    await expect(row).toContainText('Paused by you');
  });
});
