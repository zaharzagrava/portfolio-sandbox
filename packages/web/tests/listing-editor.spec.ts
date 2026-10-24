import { expect, test } from '@playwright/test';
import { register, seedProduct, shopPath } from './helpers';
import { openShopByApi } from './seller-setup';

/**
 * W04 F1 journey "listing editor" (S06, happy path): the owner of a fresh shop opens a product's draft from the inventory
 * menu, edits the title live over the editing connection, saves a named version, publishes, and sees the new title in the
 * inventory. The close-code, reconnect and error cases are unit tests in `components/seller/editor/listing-editor.test.tsx`.
 *
 * Needs the collaboration endpoint of the dev stack (`wss` on the API host) to be reachable from the browser; the page's
 * connect-src must allow it (W07, see gaps.md "Sibling-spec follow-ups").
 */
test.describe('Seller listing editor', () => {
  test('owner edits a draft live, saves a version and publishes it', async ({ page }) => {
    const member = const member = await register(page);
    const { shopId } = await openShopByApi(member);
    const original = 'Draft Test Mug';
    await seedProduct(shopId, { title: original, brand: 'Clay Works', category: 'kitchen', priceMinor: 2450, quantity: 7, description: 'Hand thrown.' }, member);

    await page.goto(shopPath(shopId, 'inventory'));
    await page.getByRole('button', { name: `Actions for ${original}` }).click();
    await page.getByRole('menuitem', { name: 'Edit together' }).click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}\/draft$/);

    await page.getByRole('button', { name: 'Start a draft' }).click();
    await expect(page.getByText('Live. Changes are shared as you type.')).toBeVisible({ timeout: 30_000 });
    const title = page.getByLabel('Title');
    await expect(title).toHaveValue(original);
    await expect(page.getByLabel('Brand')).toHaveValue('Clay Works');
    await expect(page.getByLabel('Price (EUR)')).toHaveValue('24.50');

    await title.fill(`${original} XL`);
    await page.getByLabel('Version name').fill('Bigger mug');
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.getByText('Version saved')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Saved versions' })).toContainText('Bigger mug');

    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('dialog', { name: 'Publish this draft?' }).getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/Published as version \d+\./)).toBeVisible({ timeout: 30_000 });
    await expect(title).toHaveAttribute('readonly', '');

    await page.goto(shopPath(shopId, 'inventory'));
    await expect(page.getByRole('row').filter({ hasText: `${original} XL` })).toBeVisible();
  });
});
