import { expect, test, type Page } from '@playwright/test';
import { register, sellerCall, shopPath } from '../../helpers';
import { openShopByApi } from '../../seller-setup';
import { tokenOf, watchApi } from '../cross-cutting/support';
import { archiveAll, makePro, openInventory, seedAll, sql, tableRows } from './support';

/**
 * AI QA map `inventory`, sections "tabs" and "filter" (pass 2): the Active/Archived tabs, the Stock select, the address they write,
 * the empty texts, odd address values, reload, and the phone sheet. One Pro shop with 22 active (3 stock levels and 19 fillers) and
 * 2 archived products is shared by the tests of this file; they only read it.
 */

const PHONE_MAX = 640;
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= PHONE_MAX;
/** On a phone the tabs and the Stock select sit in the Filters sheet. */
async function openFilters(page: Page) {
  if (!isPhone(page)) return;
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
}
async function closeFilters(page: Page) {
  if (!isPhone(page)) return;
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog', { name: 'Filters' })).toHaveCount(0);
}
const tab = (page: Page, name: 'Active' | 'Archived') => page.getByRole('tab', { name });
const stock = (page: Page) => page.locator('select#inventory-stock:visible');
const products = (page: Page) => page.getByRole('region', { name: 'Products' });

let member: { email: string };
let shopId: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  member = await register(page);
  ({ shopId } = await openShopByApi(member));
  await makePro(shopId);
  await seedAll(member, shopId, Array.from({ length: 19 }, (_, i) => ({ title: `Pad ${String(i + 1).padStart(2, '0')}`, quantity: 10 })));
  await seedAll(member, shopId, [{ title: 'F Many', quantity: 50 }, { title: 'F Low', quantity: 3 }, { title: 'F Zero', quantity: 0 }]);
  await archiveAll(member, shopId, await seedAll(member, shopId, [{ title: 'F AZero', quantity: 0 }, { title: 'F AFive', quantity: 5 }]));
  await context.close();
});

/** All titles of the list, following "Next page". */
async function allTitles(page: Page): Promise<string[]> {
  const titles: string[] = [];
  for (;;) {
    const rows = await tableRows(page);
    titles.push(...rows.map((cells) => cells[0]));
    const next = page.getByRole('link', { name: 'Next page' });
    if (!(await next.count())) return titles;
    await next.click();
    await expect.poll(async () => (await tableRows(page))[0]?.[0]).not.toBe(rows[0][0]);
  }
}
const stored = async (status: string, where = 'TRUE') =>
  (await sql<{ title: string }>(`SELECT title FROM "Product" WHERE "shopId" = $1 AND status = $2 AND ${where} ORDER BY "createdAt" DESC, id DESC`, [shopId, status])).map((row) => row.title);

test.describe('Inventory tabs and stock filter', () => {
  test('[inventory.tabs.active, inventory.tabs.archived, inventory.tabs.aria] Active is the default and not in the address; Archived writes ?status=ARCHIVED as a history entry; the selected tab does nothing', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.tabs.active,inventory.tabs.archived,inventory.tabs.aria' });
    await openInventory(page, member, shopId);
    await openFilters(page);
    await expect(page.getByRole('tablist', { name: 'Product status' })).toBeVisible();
    await expect(tab(page, 'Active')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Archived')).toHaveAttribute('aria-selected', 'false');
    expect(new URL(page.url()).search).toBe('');
    await closeFilters(page);
    expect(await allTitles(page)).toEqual(await stored('ACTIVE'));

    // the selected tab does nothing: no new address, no history entry
    await openInventory(page, member, shopId);
    await openFilters(page);
    const history = await page.evaluate(() => window.history.length);
    await tab(page, 'Active').click();
    expect(await page.evaluate(() => window.history.length)).toBe(history);
    expect(new URL(page.url()).search).toBe('');

    await tab(page, 'Archived').click();
    await expect(page).toHaveURL(/[?&]status=ARCHIVED$/);
    expect(await page.evaluate(() => window.history.length)).toBe(history + 1);
    await expect(tab(page, 'Archived')).toHaveAttribute('aria-selected', 'true');
    await expect(stock(page)).toBeEnabled();
    await closeFilters(page);
    await expect.poll(async () => (await tableRows(page)).map((cells) => cells[0])).toEqual(await stored('ARCHIVED'));
    expect((await tableRows(page)).every((cells) => cells[3] === 'Archived')).toBe(true);
    const token = await tokenOf(member);
    const api = await sellerCall('GET', `/api/shops/${shopId}/products?status=ARCHIVED&limit=20`, undefined, token);
    expect((api.data.items as { title: string }[]).map((item) => item.title)).toEqual(await stored('ARCHIVED'));
    // Back returns to Active (the push is a history entry)
    await page.goBack();
    await expect(page).not.toHaveURL(/status=/);
    await expect(page.getByRole('rowheader', { name: 'F Zero' })).toBeVisible();
  });

  test('[inventory.tabs.keyboard] Left/Right wrap, Home and End move the selection and the focus; only the selected tab is in the Tab order', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.tabs.keyboard' });
    await openInventory(page, member, shopId);
    await openFilters(page);
    await expect(tab(page, 'Active')).toHaveAttribute('tabindex', '0');
    await expect(tab(page, 'Archived')).toHaveAttribute('tabindex', '-1');
    await tab(page, 'Active').focus();
    const moves: [string, 'Active' | 'Archived', RegExp | null][] = [
      ['ArrowRight', 'Archived', /status=ARCHIVED/],
      ['ArrowRight', 'Active', null], // wraps
      ['ArrowLeft', 'Archived', /status=ARCHIVED/], // wraps
      ['Home', 'Active', null],
      ['End', 'Archived', /status=ARCHIVED/],
    ];
    for (const [key, expected, address] of moves) {
      await page.keyboard.press(key);
      await expect(tab(page, expected)).toBeFocused();
      await expect(tab(page, expected)).toHaveAttribute('aria-selected', 'true');
      if (address) await expect(page).toHaveURL(address);
      else await expect(page).not.toHaveURL(/status=/);
      await expect(tab(page, expected)).toHaveAttribute('tabindex', '0');
    }
  });

  test('[inventory.filter.stock-select, inventory.filter.in-stock, inventory.filter.out-of-stock, inventory.filter.status-and-stock] the Stock select writes inStock, resets the cursor, and the rows equal the database', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.stock-select,inventory.filter.in-stock,inventory.filter.out-of-stock,inventory.filter.status-and-stock' });
    await openInventory(page, member, shopId);
    await openFilters(page);
    await expect(stock(page).locator('option')).toHaveText(['All', 'In stock', 'Out of stock']);
    await expect(stock(page)).toHaveValue('');
    // a page-2 address first, to see the cursor reset
    await closeFilters(page);
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/cursor=/);
    await openFilters(page);
    await stock(page).selectOption('false');
    await expect(page).toHaveURL(/[?&]inStock=false$/); // inStock only: the cursor is gone
    await closeFilters(page);
    await expect.poll(async () => (await tableRows(page)).map((cells) => cells[0])).toEqual(['F Zero']);
    expect(await stored('ACTIVE', 'quantity = 0')).toEqual(['F Zero']);
    expect((await tableRows(page))[0][3]).toContain('Out of stock');

    await openFilters(page);
    await stock(page).selectOption('true');
    await expect(page).toHaveURL(/[?&]inStock=true$/);
    await closeFilters(page);
    await expect(page.getByRole('rowheader', { name: 'F Zero' })).toHaveCount(0);
    const inStock = await allTitles(page);
    expect(inStock).toEqual(await stored('ACTIVE', 'quantity > 0'));
    expect(inStock).toContain('F Low'); // low stock counts as in stock
    const token = await tokenOf(member);
    const api = await sellerCall('GET', `/api/shops/${shopId}/products?inStock=true&limit=50`, undefined, token);
    expect((api.data.items as { title: string }[]).map((item) => item.title)).toEqual(inStock);

    await openFilters(page);
    await stock(page).selectOption('');
    await expect(page).not.toHaveURL(/inStock/);
    await closeFilters(page);

    // Archived plus Out of stock
    await page.goto(`${shopPath(shopId, 'inventory')}?status=ARCHIVED&inStock=false`);
    expect((await tableRows(page)).map((cells) => cells[0])).toEqual(await stored('ARCHIVED', 'quantity = 0'));
    expect(await stored('ARCHIVED', 'quantity = 0')).toEqual(['F AZero']);
    await page.goto(`${shopPath(shopId, 'inventory')}?status=ARCHIVED&inStock=true`);
    expect((await tableRows(page)).map((cells) => cells[0])).toEqual(['F AFive']);
  });

  test('[inventory.filter.invalid-url-values] odd addresses fall back to the defaults and never error', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.invalid-url-values' });
    const expectedActive = (await stored('ACTIVE')).slice(0, 20);
    for (const query of ['?status=BOGUS', '?inStock=maybe', '?status=archived', '?inStock=TRUE', '?cursor=%00%00', '?cursor=' + 'a'.repeat(600)]) {
      await openInventory(page, member, shopId, query);
      await expect(products(page).getByRole('alert')).toHaveCount(0);
      await expect(products(page).getByText(/Check this field|went wrong|couldn't load/)).toHaveCount(0);
      expect((await tableRows(page)).map((cells) => cells[0]), query).toEqual(expectedActive);
      await openFilters(page);
      await expect(tab(page, 'Active')).toHaveAttribute('aria-selected', 'true');
      await expect(stock(page)).toHaveValue('');
      await closeFilters(page);
    }
  });

  test('[inventory.filter.invalid-url-values] a repeated status or stock value falls back to the default, in the server render and in the page (P2F2)', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.invalid-url-values-repeated' });
    const expectedActive = (await stored('ACTIVE')).slice(0, 20);
    for (const query of ['?status=ACTIVE&status=ARCHIVED', '?inStock=true&inStock=false']) {
      await openInventory(page, member, shopId, query);
      await page.waitForTimeout(1500); // let the page's own read settle: the bug shows after the server render
      await openFilters(page);
      await expect(tab(page, 'Active'), query).toHaveAttribute('aria-selected', 'true');
      await expect(stock(page), query).toHaveValue('');
      await closeFilters(page);
      expect((await tableRows(page)).map((cells) => cells[0]), query).toEqual(expectedActive);
    }
  });

  test('[inventory.filter.invalid-url-values] a search address of more than 200 characters falls back and never errors (P1F3)', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.invalid-url-values-q' });
    await openInventory(page, member, shopId, `?q=${'z'.repeat(250)}`);
    await page.waitForTimeout(1500);
    await expect(products(page).getByText(/Check this field|went wrong|couldn't load/)).toHaveCount(0);
  });

  test('[inventory.filter.url-reload] an address with status, stock and a cursor shows the same view after a reload and in a second tab', async ({ page, context }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.url-reload' });
    await openInventory(page, member, shopId);
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/cursor=/);
    const address = page.url();
    const before = await tableRows(page);
    expect(before.length).toBe(2); // Pad 02, Pad 01
    await page.reload();
    expect(await tableRows(page)).toEqual(before);
    const second = await context.newPage();
    await second.goto(address);
    expect(await tableRows(second)).toEqual(before);
    await second.close();

    await openInventory(page, member, shopId, '?status=ARCHIVED&inStock=true');
    const archived = await tableRows(page);
    await page.reload();
    expect(await tableRows(page)).toEqual(archived);
    expect(archived.map((cells) => cells[0])).toEqual(['F AFive']);
    await openFilters(page);
    await expect(tab(page, 'Archived')).toHaveAttribute('aria-selected', 'true');
    await expect(stock(page)).toHaveValue('true');
  });
});

test.describe('Inventory empty results', () => {
  test('[inventory.filter.empty-result] no match: the filter text with Clear filters; Archived with nothing says "No archived products." without a button, also with the Stock filter', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.empty-result' });
    await page.goto('/');
    const owner = await register(page);
    const shop = await openShopByApi(owner);
    await seedAll(owner, shop.shopId, [{ title: 'Only Mug', quantity: 4 }]);
    await openInventory(page, owner, shop.shopId, '?inStock=false');
    await expect(products(page).getByText('No products match these filters.')).toBeVisible();
    await products(page).getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/inStock/);
    await expect(page.getByRole('rowheader', { name: 'Only Mug' })).toBeVisible();

    await page.goto(`${shopPath(shop.shopId, 'inventory')}?status=ARCHIVED`);
    await expect(products(page).getByText('No archived products.')).toBeVisible();
    await expect(products(page).getByRole('button')).toHaveCount(0);
    await page.goto(`${shopPath(shop.shopId, 'inventory')}?status=ARCHIVED&inStock=true`);
    await expect(products(page).getByText('No archived products.')).toBeVisible();
    await expect(products(page).getByText('No products match these filters.')).toHaveCount(0);
  });
});

test.describe('Inventory filters on a phone and on a desktop', () => {
  test('[inventory.filter.phone-sheet, inventory.filter.clear-filters, inventory.filter.sheet-keyboard] the Filters button counts the set filters, the sheet holds them, Clear filters goes to the plain address, Escape returns focus', async ({ page }) => {
    test.skip(!isPhone(page), 'phone only');
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.phone-sheet,inventory.filter.clear-filters,inventory.filter.sheet-keyboard' });
    await openInventory(page, member, shopId);
    const button = page.getByRole('button', { name: /^Filters/ });
    await expect(button).toHaveText('Filters');
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(300); // full width at 390 px
    await expect(page.locator('[data-filters-inline]')).toBeHidden();

    await button.click();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    await expect(sheet).toBeVisible();
    await expect(page.locator('[data-filters-inline]')).toHaveAttribute('inert', '');
    await expect(sheet.getByRole('tab', { name: 'Archived' })).toBeVisible();
    await expect(sheet.locator('select')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Done' })).toBeVisible();
    // focus trap: Tab many times, the focus never leaves the sheet
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(button).toBeFocused();

    await button.click();
    await tab(page, 'Archived').click();
    await expect(page).toHaveURL(/status=ARCHIVED/);
    await stock(page).selectOption('true');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(button).toHaveText('Filters (2 on)');
    await expect(page).toHaveURL(/status=ARCHIVED&inStock=true|inStock=true&status=ARCHIVED/);

    await button.click();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(shopPath(shopId, 'inventory'));
    await expect(tab(page, 'Active')).toHaveAttribute('aria-selected', 'true');
    await expect(stock(page)).toHaveValue('');
    // Clear filters also drops a search text
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByLabel('Search your products').fill('zzzz');
    await expect(page).toHaveURL(/q=zzzz/);
    await button.click();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(page.getByLabel('Search your products')).toHaveValue('');
  });

  test('[inventory.filter.desktop-inline] from 641 px up the filters are inline, there is no Filters button, and the Stock label is tied to the select', async ({ page }) => {
    test.skip(isPhone(page), 'desktop only');
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.desktop-inline' });
    await openInventory(page, member, shopId);
    await expect(page.getByRole('button', { name: /^Filters/ })).toBeHidden();
    await expect(page.locator('[data-filters-inline]')).toBeVisible();
    await expect(page.locator('label[for="inventory-stock"]')).toHaveText('Stock');
    await expect(page.locator('select#inventory-stock')).toBeVisible();
    await page.setViewportSize({ width: 641, height: 800 });
    await expect(page.getByRole('button', { name: /^Filters/ })).toBeHidden();
  });

  test('[inventory.filter.desktop-inline] at exactly 640 px (the phone limit) the filters sit in the sheet (P2F3)', async ({ page }) => {
    test.skip(isPhone(page), 'desktop only');
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.desktop-inline-640' });
    await openInventory(page, member, shopId);
    await page.setViewportSize({ width: 640, height: 800 });
    await expect(page.getByRole('button', { name: /^Filters/ })).toBeVisible();
  });

  test('[inventory.filter.phone-sheet] the Stock select inside the sheet has its own accessible name (P2F1)', async ({ page }) => {
    test.skip(!isPhone(page), 'phone only');
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.phone-sheet-label' });
    await openInventory(page, member, shopId);
    await openFilters(page);
    await expect(page.getByRole('dialog', { name: 'Filters' }).locator('select')).toHaveAccessibleName('Stock');
  });
});
