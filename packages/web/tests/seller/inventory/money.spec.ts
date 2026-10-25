import { expect, test } from '@playwright/test';
import { devMailboxLists, joinShopAs, ownerWithShop, type Member } from '../cross-cutting/support';
import { openInventory, seedAll, sql } from './support';

/**
 * AI QA map `inventory`, lines that need a currency other than the platform's (the Add form always uses the platform currency,
 * so the price rules of other currencies are reached through the Edit dialog of a product stored in that currency) and the
 * empty list as a viewer sees it.
 */

const edit = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Edit product' });

test('[inventory.add.price-zero-decimal-currency] a JPY product asks for a whole number and sends it as minor units; a KWD product allows 3 decimals', async ({ page }) => {
  test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.price-zero-decimal-currency' });
  const { member, shopId } = await ownerWithShop(page);
  await seedAll(member, shopId, [{ title: 'Yen Mug', currency: 'JPY', priceMinor: 500 }, { title: 'Dinar Mug', currency: 'KWD', priceMinor: 1500 }]);
  await openInventory(page, member, shopId);

  await page.getByRole('button', { name: 'Actions for Yen Mug', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(edit(page).getByLabel('Price (JPY)', { exact: true })).toHaveValue('500');
  const price = edit(page).getByLabel('Price (JPY)', { exact: true });
  const save = edit(page).getByRole('button', { name: 'Save changes' });
  for (const [text, message] of [['abc', 'Enter a whole number.'], ['1.5', 'Use a whole number.'], ['12,5', 'Use a whole number.']]) {
    await price.fill(text);
    await save.click();
    await expect(edit(page).getByRole('alert').getByRole('listitem'), `JPY "${text}"`).toHaveText([message]);
  }
  await price.fill('1500');
  const sent = page.waitForRequest((request) => request.method() === 'PATCH' && /\/products\/[^/]+$/.test(request.url()));
  await save.click();
  expect((await sent).postDataJSON()).toMatchObject({ priceMinor: 1500 });
  await expect(edit(page)).toHaveCount(0);
  expect(Number((await sql(`SELECT "priceMinor" FROM "Product" WHERE "shopId" = $1 AND title = 'Yen Mug'`, [shopId]))[0].priceMinor)).toBe(1500);

  await page.getByRole('button', { name: 'Actions for Dinar Mug', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const kwd = edit(page).getByLabel('Price (KWD)', { exact: true });
  await expect(kwd).toHaveValue('1.500');
  await kwd.fill('1.2345');
  await edit(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(edit(page).getByRole('alert').getByRole('listitem')).toHaveText(['Use at most 3 decimal places.']);
  await kwd.fill('2.345');
  const sentKwd = page.waitForRequest((request) => request.method() === 'PATCH' && /\/products\/[^/]+$/.test(request.url()));
  await edit(page).getByRole('button', { name: 'Save changes' }).click();
  expect((await sentKwd).postDataJSON()).toMatchObject({ priceMinor: 2345 });
  await expect(edit(page)).toHaveCount(0);
  expect(Number((await sql(`SELECT "priceMinor" FROM "Product" WHERE "shopId" = $1 AND title = 'Dinar Mug'`, [shopId]))[0].priceMinor)).toBe(2345);
});

test('[inventory.empty.none] a viewer of a shop with no products sees the text only, no button', async ({ page, browser }) => {
  test.skip(!(await devMailboxLists()), 'the dev mailbox is needed to invite members');
  test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.empty.none' });
  const { member, shopId } = await ownerWithShop(page);
  const viewer = await joinShopAs(browser, member, shopId, 'VIEWER');
  await openInventory(viewer.page, viewer.member as Member, shopId);
  const region = viewer.page.getByRole('region', { name: 'Products' });
  await expect(region.getByText('No products yet.')).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Add product' })).toHaveCount(0);
  await viewer.context.close();
});

test('[inventory.add.server-validation] the API itself answers validation_failed with the wire field names the form maps (title, brand, category, priceMinor, quantity)', async ({ page }) => {
  test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.server-validation' });
  const { shopId, token } = await ownerWithShop(page);
  const { sellerCall } = await import('../../helpers');
  const refused = await sellerCall('POST', `/api/shops/${shopId}/products`, { title: '', brand: '', category: '', priceMinor: 0, currency: 'EUR', quantity: -1 }, token);
  expect([refused.status, refused.data.code]).toEqual([400, 'validation_failed']);
  const fields = (refused.data.errors as { field: string }[]).map((entry) => entry.field).sort();
  expect(fields).toEqual(expect.arrayContaining(['title', 'brand', 'category', 'priceMinor', 'quantity']));
  expect((await sql(`SELECT 1 FROM "Product" WHERE "shopId" = $1`, [shopId])).length).toBe(0);
});
