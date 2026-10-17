import { expect, test, type Page } from '@playwright/test';
import { openFiltersIfCollapsed, openShop, register, seedProduct, shopPath } from './helpers';

/**
 * W04 journey "inventory" (AS-33, AS-36, AS-30, AS-40): the owner of a freshly opened shop adds a product, edits its stock,
 * finds it by a typo search and archives it. The shop is the member's own, so no other test shares its stock (L-005, L-006);
 * the neighbour row is created through the real API with `seedProduct`.
 */

const TITLE = 'Handmade Ceramic Mug';
const rowOf = (page: Page, title: string) => page.getByRole('row').filter({ hasText: title });

test.describe('Seller inventory', () => {
  test('owner adds, finds, edits and archives a product', async ({ page }) => {
    const member = await register(page);
    const { shopId } = await openShop(page);
    await seedProduct(shopId, { title: 'Seeded Walnut Spoon', quantity: 4 }, member);
    await page.goto(shopPath(shopId, 'inventory'));
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
    await expect(rowOf(page, 'Seeded Walnut Spoon')).toContainText('Low stock');

    // Step 1 (AS-33): add a product; it is the first row, the form is reset and focus returns to "Add product".
    const add = page.getByRole('button', { name: 'Add product' }).first();
    await add.click();
    const create = page.getByRole('dialog', { name: 'Add product' });
    await create.getByLabel('Title').fill(TITLE);
    await create.getByLabel('Brand').fill('Clay Works');
    await create.getByLabel('Category').fill('kitchen');
    await create.getByLabel('Price (EUR)').fill('24.50');
    await create.getByLabel('Stock').fill('12');
    await create.getByRole('button', { name: 'Create product' }).click();
    await expect(page.getByText('Product created')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(add).toBeFocused();
    await expect(rowOf(page, TITLE)).toContainText('€24.50');
    await expect(rowOf(page, TITLE)).toContainText('In stock');

    // Step 2 (AS-36): edit the stock; the row shows the new number and status.
    await page.getByRole('button', { name: `Actions for ${TITLE}` }).click();
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit product' });
    await expect(edit.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await edit.getByLabel('Stock').fill('3');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Product updated')).toBeVisible();
    await expect(rowOf(page, TITLE)).toContainText('Low stock');

    // Step 3 (AS-30): a typo still finds it. The search index lags behind a new product, so the search is repeated until it shows.
    const search = page.getByRole('searchbox', { name: 'Search your products' });
    await expect(async () => {
      await search.fill('');
      await search.fill('ceramc mug');
      await expect(page).toHaveURL(/q=ceramc/, { timeout: 3_000 });
      await expect(rowOf(page, TITLE)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
    const filters = await openFiltersIfCollapsed(page);
    await expect(filters.getByRole('tab', { name: 'Archived' })).toBeDisabled();
    if (await page.getByRole('dialog', { name: 'Filters' }).isVisible()) await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText('Search covers all products.')).toBeVisible();

    // Step 4 (AS-40): archive with the confirmation; it is then in the Archived tab and can come back.
    await page.getByRole('button', { name: `Actions for ${TITLE}` }).click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    const confirm = page.getByRole('dialog', { name: 'Archive product?' });
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Archive product' }).click();
    await expect(page.getByText('Product archived')).toBeVisible();
    await search.fill('');
    await expect(page).not.toHaveURL(/q=/);
    await expect(rowOf(page, TITLE)).toBeHidden();
    await (await openFiltersIfCollapsed(page)).getByRole('tab', { name: 'Archived' }).click();
    await expect(page).toHaveURL(/status=ARCHIVED/);
    if (await page.getByRole('dialog', { name: 'Filters' }).isVisible()) await page.getByRole('button', { name: 'Done' }).click();
    await expect(rowOf(page, TITLE)).toContainText('Archived');
  });
});
