import { expect, test } from '@playwright/test';
import { register, shopPath } from '../../helpers';
import { openShopByApi } from '../../seller-setup';
import { UNKNOWN_ID, mainText, ownerWithShop, watchApi } from '../cross-cutting/support';
import { openInventory, seedAll } from './support';

/**
 * AI QA map `inventory`, section "page": opening the inventory address (guard, unknown shops, old address, menu entry, headings,
 * phone layout, first-read failure). Each test names the map lines it covers in its title and in the `aiqa-lines` annotation.
 */

test.describe('Inventory page: opening it', () => {
  test('[inventory.page.route-open, inventory.page.heading-caption] the page shows its heading, the shop and a labelled table', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.route-open,inventory.page.heading-caption' });
    const member = await register(page);
    const { shopId, shopName } = await openShopByApi(member);
    await seedAll(member, shopId, [{ title: 'Page Mug One' }, { title: 'Page Mug Two' }]);
    await openInventory(page, member, shopId);

    await expect(page.getByText(`The products of ${shopName}.`)).toBeVisible();
    const products = page.getByRole('region', { name: 'Products' });
    await expect(products.getByRole('row')).toHaveCount(3); // header + 2 products
    await expect(page.getByRole('table')).toHaveAccessibleName(`Products of ${shopName}`);
    for (const header of ['Name', 'Price', 'Stock', 'Status', 'Actions']) await expect(page.getByRole('columnheader', { name: header })).toHaveAttribute('scope', 'col');
    await expect(page.getByRole('rowheader', { name: 'Page Mug Two' })).toHaveAttribute('scope', 'row');
  });

  test('[inventory.page.signed-out] a signed-out visitor is sent to the sign-in page with the full address as returnTo', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.signed-out' });
    const response = await page.goto(`${shopPath(UNKNOWN_ID, 'inventory')}?q=abc&status=ARCHIVED`);
    expect(await response?.text()).not.toContain('Products of');
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe(`${shopPath(UNKNOWN_ID, 'inventory')}?q=abc&status=ARCHIVED`);
  });

  test('[inventory.page.legacy-redirect] the old address goes to the only shop, to the picker for two shops, to sign-in when signed out', async ({ page, browser }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.legacy-redirect' });
    const anonymous = await browser.newContext();
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto('/dashboard/seller/inventory');
    await expect(anonymousPage).toHaveURL(/\/login\?returnTo=%2Fdashboard%2Fseller%2Finventory$/);
    await anonymous.close();

    const { shopId, member } = await ownerWithShop(page);
    await page.goto('/dashboard/seller/inventory');
    await expect(page).toHaveURL(new RegExp(`${shopPath(shopId, 'inventory')}$`));

    const { openSecondShop } = await import('../cross-cutting/support');
    await openSecondShop(member);
    await page.goto('/dashboard/seller/inventory');
    await expect(page).toHaveURL(/\/dashboard\/seller$/);
    await expect(page.getByRole('heading', { name: 'Your shops' })).toBeVisible();
  });

  test('[inventory.page.bad-shop-id] a malformed, unknown or foreign shop gives the same not-found page and no products call', async ({ page, browser }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.bad-shop-id' });
    const other = await browser.newContext();
    const foreign = await ownerWithShop(await other.newPage());
    await register(page);
    const api = watchApi(page);
    const texts: string[] = [];
    for (const id of ['not-a-uuid', UNKNOWN_ID, foreign.shopId]) {
      await page.goto(shopPath(id, 'inventory'));
      await expect(page.getByText("We couldn't find that shop.")).toBeVisible();
      texts.push(await mainText(page));
    }
    expect(new Set(texts).size).toBe(1);
    expect(api.count('GET', /\/products/)).toBe(0);
    await other.close();
  });

  test('[inventory.page.menu-entry] the Inventory entry marks the current page, also in the phone menu', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.menu-entry' });
    const { shopId, member } = await ownerWithShop(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openInventory(page, member, shopId);
    await expect(page.getByRole('link', { name: 'Inventory' })).toHaveAttribute('aria-current', 'page');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('link', { name: 'Inventory' })).toBeHidden();
    await page.getByRole('region', { name: 'Shop bar' }).getByRole('button', { name: 'Open seller menu' }).click();
    await expect(page.getByRole('dialog').getByRole('link', { name: 'Inventory' })).toHaveAttribute('aria-current', 'page');
  });

  test('[inventory.page.menu-entry-extra-1] the two phone menu buttons have different accessible names', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.menu-entry-extra-1' });
    const { shopId, member } = await ownerWithShop(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openInventory(page, member, shopId);
    const names = await page.getByRole('button', { name: /menu/i }).evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
    expect(new Set(names).size, `menu buttons: ${names.join(' | ')}`).toBe(names.length);
  });

  test('[inventory.page.first-page-error-retry] a failed first read shows the section error with Try again, not an error page', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.first-page-error-retry' });
    const { shopId, member } = await ownerWithShop(page);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    // a 150-character search makes the server's own first read fail (the API refuses text over 100)
    await page.goto(`${shopPath(shopId, 'inventory')}?q=${'a'.repeat(150)}`);
    const products = page.getByRole('region', { name: 'Products' });
    await expect(products.getByRole('button', { name: 'Try again' })).toBeVisible();
    const before = api.count('GET', /\/products\/search$/);
    await products.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => api.count('GET', /\/products\/search$/)).toBeGreaterThan(before);
  });

  test('[inventory.page.phone-layout] at 390 px nothing scrolls sideways and the controls are at least 44 px high', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.phone-layout' });
    const { shopId, member } = await ownerWithShop(page, [{ title: 'Phone Mug' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await openInventory(page, member, shopId);
    await expect(page.getByRole('rowheader', { name: 'Phone Mug' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.getByRole('table').evaluate((table) => getComputedStyle(table).display)).toBe('block');
    for (const control of [page.getByRole('searchbox'), page.getByRole('button', { name: /Filters/ }), page.getByRole('button', { name: 'Add product' }).first(), page.getByRole('button', { name: 'Actions for Phone Mug' })]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});
