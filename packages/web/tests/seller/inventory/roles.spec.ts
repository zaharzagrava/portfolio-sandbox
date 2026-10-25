import { expect, test, type Page } from '@playwright/test';
import { NEW_USER_PASSWORD, register, sellerCall, sellerMenu, shopPath } from '../../helpers';
import { openSecondShop, setSuspended, tokenOf, watchApi } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { setShopStatus, userId } from '../support/db';
import { acceptInvite, memberWithRole, ownerByApi, type Role } from '../entry/support';
import { openInventory, seedAll, sql } from './support';
import { menuButton, openRowAction, productRow } from './write-support';

/**
 * AI QA map `inventory`, section "roles and shop states": what OWNER, ADMIN, STAFF and VIEWER see and can do on the inventory
 * page, the direct API for a VIEWER and a non-member, a role lowered while the page is open, permissions read from the shop
 * answer, suspended and closing shops, and the shop switcher. Each test has shops of its own.
 */

const FULL_MENU = ['Edit', 'Adjust stock', 'Photos and video', 'Edit together', 'Archive'];
const here = (shopId: string, query = '') => `${shopPath(shopId, 'inventory')}${query}`;

async function exerciseEveryControl(page: Page, shopId: string, titles: string[]) {
  const [first, second] = titles;
  await page.goto(here(shopId));
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
  const api = watchApi(page);
  // add
  const add = page.getByRole('button', { name: 'Add product' });
  await expect(add).toBeEnabled();
  await add.click();
  const form = page.getByRole('dialog', { name: 'Add product' });
  await form.getByLabel('Title', { exact: true }).fill('Role Added');
  await form.getByLabel('Brand', { exact: true }).fill('Brand');
  await form.getByLabel('Category', { exact: true }).fill('cat');
  await form.getByLabel('Price (EUR)', { exact: true }).fill('5.00');
  await form.getByLabel('Stock', { exact: true }).fill('4');
  await form.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByText('Product created')).toBeVisible();
  await expect(page.getByRole('row', { name: /Role Added/ })).toBeVisible();
  // menu shows everything
  await menuButton(page, first).click();
  expect(await page.getByRole('menuitem').allInnerTexts()).toEqual(FULL_MENU);
  // edit (from the open menu)
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit product' });
  await edit.getByLabel('Brand', { exact: true }).fill('Edited');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Product updated')).toBeVisible();
  // adjust stock
  await openRowAction(page, first, 'Adjust stock');
  const popover = page.getByRole('dialog', { name: `Adjust stock of ${first}` });
  await popover.getByLabel('New stock').fill('1');
  await popover.getByRole('button', { name: 'Update stock' }).click();
  await expect(page.getByText('Stock updated')).toBeVisible();
  await expect(popover).toHaveCount(0);
  // archive then restore
  await openRowAction(page, second, 'Archive');
  await page.getByRole('dialog', { name: 'Archive product?' }).getByRole('button', { name: 'Archive product' }).click();
  await expect(page.getByText('Product archived')).toBeVisible();
  await page.goto(here(shopId, '?status=ARCHIVED'));
  await openRowAction(page, second, 'Restore');
  await expect(page.getByText('Product restored')).toBeVisible();
  const statuses = api.writes().map((entry) => `${entry.method} ${entry.status}`);
  expect(statuses).toEqual(['POST 201', 'PATCH 200', 'PATCH 200', 'POST 200', 'POST 200']);
}

test.describe('Roles that may write', () => {
  for (const role of ['OWNER', 'ADMIN', 'STAFF'] as const) {
    test(`[inventory.roles.${role.toLowerCase()}] as ${role}: add, edit, adjust stock, archive and restore are offered and work`, async ({ browser }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: `inventory.roles.${role.toLowerCase()}` });
      test.setTimeout(60_000);
      const { page, context, owner, shopId } = await memberWithRole(browser, role as Role);
      try {
        const titles = [`${role} Mug`, `${role} Cup`];
        const ids = await seedAll(owner, shopId, titles.map((title) => ({ title })));
        await exerciseEveryControl(page, shopId, titles);
        expect((await productRow(ids[0])).quantity).toBe(1);
        expect((await productRow(ids[0])).brand).toBe('Edited');
        expect((await productRow(ids[1])).status).toBe('ACTIVE');
        expect(Number((await sql(`SELECT count(*)::int AS n FROM "Product" WHERE "shopId" = $1`, [shopId]))[0].n)).toBe(3);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('VIEWER and strangers', () => {
  test('[inventory.roles.viewer, inventory.roles.viewer-direct-api] a VIEWER reads list, search, tabs, filters and paging, sees no Add product and no row menu; the stock number is plain text; direct writes get 403 permission_denied and change nothing', async ({ browser }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.roles.viewer,inventory.roles.viewer-direct-api' });
    test.setTimeout(150_000);
    const { page, context, owner, shopId, member } = await memberWithRole(browser, 'VIEWER');
    try {
      const ids = await seedAll(owner, shopId, [{ title: 'View Mug', quantity: 6 }, { title: 'View Cup', quantity: 0 }]);
      await page.goto(here(shopId));
      await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
      const rows = page.locator('tbody tr');
      await expect(rows).toHaveCount(2);
      await expect(page.getByRole('button', { name: 'Add product' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Actions for / })).toHaveCount(0);
      // the stock cell is text, not a control
      await expect(page.getByRole('row', { name: /View Mug/ }).getByRole('button')).toHaveCount(0);
      await page.getByRole('row', { name: /View Mug/ }).getByText('6').first().click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // tabs, filter and search work
      if ((page.viewportSize()?.width ?? 1280) <= 640) {
        await page.getByRole('button', { name: 'Filters' }).click(); // on a phone the tabs sit in the Filters sheet
        await page.getByRole('dialog', { name: 'Filters' }).getByRole('tab', { name: 'Archived' }).click();
      } else await page.getByRole('tab', { name: 'Archived' }).click();
      await expect(page).toHaveURL(/status=ARCHIVED/);
      await expect(page.getByText('No archived products.')).toBeVisible();
      await page.goto(here(shopId, '?inStock=false'));
      await expect(page.getByRole('row', { name: /View Cup/ })).toBeVisible();
      await expect(page.getByRole('row', { name: /View Mug/ })).toHaveCount(0);
      await expect.poll(async () => Number((await sql(`SELECT count(*)::int AS n FROM "SearchShopProduct" WHERE "shopId" = $1`, [shopId]))[0].n), { timeout: 90_000 }).toBe(2);
      await page.goto(here(shopId));
      await page.getByLabel('Search your products').fill('View Mug');
      await expect(page.getByRole('rowheader', { name: 'View Mug' })).toBeVisible();
      await expect(page.getByRole('rowheader', { name: 'View Cup' })).toHaveCount(0);
      // direct API
      const token = await tokenOf({ email: member.email, password: member.password });
      const base = `/api/shops/${shopId}/products/${ids[0]}`;
      const attempts = {
        patch: await sellerCall('PATCH', base, { expectedVersion: 1, quantity: 99 }, token),
        archive: await sellerCall('POST', `${base}/archive`, { expectedVersion: 1 }, token),
        restore: await sellerCall('POST', `${base}/restore`, { expectedVersion: 1 }, token),
        create: await sellerCall('POST', `/api/shops/${shopId}/products`, { title: 'Nope', brand: 'B', category: 'c', priceMinor: 100, quantity: 1 }, token),
        read: await sellerCall('GET', base, undefined, token),
      };
      for (const [name, result] of Object.entries(attempts)) {
        if (name === 'read') expect([name, result.status]).toEqual([name, 200]);
        else expect([name, result.status, result.data.code], JSON.stringify(result.data)).toEqual([name, 403, 'permission_denied']);
      }
      const row = await productRow(ids[0]);
      expect([row.quantity, row.version, row.status]).toEqual([6, 1, 'ACTIVE']);
      expect(Number((await sql(`SELECT count(*)::int AS n FROM "Product" WHERE "shopId" = $1`, [shopId]))[0].n)).toBe(2);
    } finally {
      await context.close();
    }
  });

  test('[inventory.roles.non-member] a user outside the shop gets the same 404 for list, search, read and writes as for an unknown shop', async () => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.roles.non-member' });
    const { owner, shopId } = await ownerByApi();
    const [id] = await seedAll(owner, shopId, [{ title: 'Private Mug' }]);
    const { owner: stranger, ...strangerShop } = await ownerByApi();
    const token = await tokenOf(stranger);
    const unknown = '11111111-1111-4111-8111-111111111111';
    const calls = (shop: string) => [
      () => sellerCall('GET', `/api/shops/${shop}/products`, undefined, token),
      () => sellerCall('GET', `/api/shops/${shop}/products/search?q=Private`, undefined, token),
      () => sellerCall('GET', `/api/shops/${shop}/products/${id}`, undefined, token),
      () => sellerCall('PATCH', `/api/shops/${shop}/products/${id}`, { expectedVersion: 1, quantity: 1 }, token),
      () => sellerCall('POST', `/api/shops/${shop}/products/${id}/archive`, { expectedVersion: 1 }, token),
      () => sellerCall('POST', `/api/shops/${shop}/products/${id}/restore`, { expectedVersion: 1 }, token),
      () => sellerCall('POST', `/api/shops/${shop}/products`, { title: 'X', brand: 'B', category: 'c', priceMinor: 100, quantity: 1 }, token),
    ];
    const foreign = calls(shopId);
    const missing = calls(unknown);
    for (let i = 0; i < foreign.length; i++) {
      const a = await foreign[i]();
      const b = await missing[i]();
      expect([i, a.status, a.data.code, b.status, b.data.code], JSON.stringify([a.data, b.data])).toEqual([i, 404, b.data.code, 404, b.data.code]);
      expect(JSON.stringify(a.data)).not.toContain('Private Mug');
    }
    // the stranger's own shop does not hand out the product either
    const crossShop = await sellerCall('GET', `/api/shops/${strangerShop.shopId}/products/${id}`, undefined, token);
    expect(crossShop.status).toBe(404);
    expect(await productRow(id)).toMatchObject({ quantity: 10, version: 1 });
  });

  test('[inventory.roles.role-change-live] a role lowered while the page is open: the next write is refused with 403 permission_denied and the page says so without breaking', async ({ browser }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.roles.role-change-live' });
    const { page, context, owner, shopId, member } = await memberWithRole(browser, 'STAFF');
    try {
      const [id] = await seedAll(owner, shopId, [{ title: 'Live Mug', quantity: 9 }]);
      await page.goto(here(shopId));
      await expect(page.getByRole('row', { name: /Live Mug/ })).toBeVisible();
      const me = userId(member.email);
      const lowered = await sellerCall('PATCH', `/api/shops/${shopId}/members/${me}`, { role: 'VIEWER' }, await tokenOf(owner));
      expect(lowered.status, JSON.stringify(lowered.data)).toBe(204);
      const api = watchApi(page);
      await openRowAction(page, 'Live Mug', 'Adjust stock');
      const popover = page.getByRole('dialog', { name: 'Adjust stock of Live Mug' });
      await popover.getByLabel('New stock').fill('1');
      await popover.getByRole('button', { name: 'Update stock' }).click();
      await expect(page.getByText("You don't have permission to do that.").first()).toBeVisible();
      expect(api.matching('PATCH', /\/products\//).map((entry) => entry.status)).toEqual([403]);
      await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
      expect((await productRow(id)).quantity).toBe(9);
      // the page keeps working after a reload, now as a VIEWER
      await page.reload();
      await expect(page.getByRole('button', { name: 'Add product' })).toHaveCount(0);
      await expect(page.getByRole('row', { name: /Live Mug/ })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe('Shop states and switching', () => {
  test('[inventory.shop.closing] a DELETING shop shows the closing banner, Add product is off with the same note, row menus are off, and writes answer 409 shop_offboarding', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.shop.closing' });
    const owner = await register(page);
    const { shopId } = await openShopByApi(owner);
    const [id] = await seedAll(owner, shopId, [{ title: 'Closing Mug' }]);
    setShopStatus(shopId, 'DELETING');
    await openInventory(page, owner, shopId);
    const note = 'This shop is being closed. You can view data but not make changes.';
    await expect(page.getByText(note).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add product' })).toBeDisabled();
    await expect(page.getByRole('row', { name: /Closing Mug/ })).toBeVisible();
    await menuButton(page, 'Closing Mug').click();
    await expect(page.getByRole('menu').getByText(note)).toBeVisible();
    for (const item of await page.getByRole('menuitem').all()) await expect(item).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    const token = await tokenOf(owner);
    const base = `/api/shops/${shopId}/products/${id}`;
    const writes = [
      await sellerCall('PATCH', base, { expectedVersion: 1, quantity: 1 }, token),
      await sellerCall('POST', `${base}/archive`, { expectedVersion: 1 }, token),
      await sellerCall('POST', `/api/shops/${shopId}/products`, { title: 'X', brand: 'B', category: 'c', priceMinor: 100, quantity: 1 }, token),
    ];
    for (const result of writes) expect([result.status, result.data.code], JSON.stringify(result.data)).toEqual([409, 'shop_offboarding']);
    expect(await productRow(id)).toMatchObject({ quantity: 10, version: 1, status: 'ACTIVE' });
  });

  test('[inventory.shop.suspended] a SUSPENDED shop shows the banner, Add product is off with the same note, and the list stays readable with its rows', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.shop.suspended' });
    const owner = await register(page);
    const { shopId } = await openShopByApi(owner);
    await seedAll(owner, shopId, [{ title: 'Frozen Mug' }]);
    await setSuspended(shopId, true);
    await openInventory(page, owner, shopId);
    const note = 'This shop is suspended. You can view data but not make changes.';
    await expect(page.getByText(note).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add product' })).toBeDisabled();
    await expect(page.getByRole('row', { name: /Frozen Mug/ })).toBeVisible();
  });

  test('[inventory.shop.suspended-reads] list, read and search on a suspended or closing shop still answer 200 (W04.R-03: reads work)', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.shop.suspended-reads' });
    const owner = await register(page);
    const { shopId } = await openShopByApi(owner);
    const [id] = await seedAll(owner, shopId, [{ title: 'Readable Mug' }]);
    const token = await tokenOf(owner);
    const reads = async () => ({
      list: (await sellerCall('GET', `/api/shops/${shopId}/products`, undefined, token)).status,
      get: (await sellerCall('GET', `/api/shops/${shopId}/products/${id}`, undefined, token)).status,
      search: (await sellerCall('GET', `/api/shops/${shopId}/products/search?q=Readable`, undefined, token)).status,
    });
    setShopStatus(shopId, 'DELETING');
    expect(await reads(), 'closing shop').toEqual({ list: 200, get: 200, search: 200 });
    setShopStatus(shopId, 'ACTIVE');
    await setSuspended(shopId, true);
    expect(await reads(), 'suspended shop').toEqual({ list: 200, get: 200, search: 200 });
  });

  test('[inventory.shop.switch-shop] switching shop in the switcher keeps the section: the other shop inventory opens with its own products and its own role', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.shop.switch-shop' });
    const owner = await register(page);
    const a = await openShopByApi(owner, 'Aiqa Switch Alpha');
    const { owner: other, ...b } = await ownerByApi('Aiqa Switch Bravo');
    await seedAll(other, b.shopId, [{ title: 'Bravo Mug' }]);
    await seedAll(owner, a.shopId, [{ title: 'Alpha Mug' }]);
    await acceptInvite(page, other, b.shopId, { email: owner.email, password: NEW_USER_PASSWORD }, 'VIEWER');
    await page.goto(here(a.shopId, '?q=Alpha'));
    await expect(page.getByRole('button', { name: 'Add product' })).toBeEnabled();
    const menu = await sellerMenu(page);
    await menu.getByRole('button').first().click();
    await menu.getByRole('list', { name: 'Your shops' }).getByRole('link').filter({ hasText: b.shopName }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/seller/${b.shopId}/inventory$`));
    await expect(page.getByRole('row', { name: /Bravo Mug/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Alpha Mug/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add product' }), 'VIEWER in the other shop').toHaveCount(0);
    await expect(page.getByLabel('Search your products')).toHaveValue('');
  });
});

void openSecondShop;
