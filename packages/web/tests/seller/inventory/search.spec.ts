import { expect, test } from '@playwright/test';
import { register, sellerCall, shopPath } from '../../helpers';
import { openShopByApi } from '../../seller-setup';
import { ownerWithShop, tokenOf, uniqueTitle, watchApi } from '../cross-cutting/support';
import { archiveAll, makePro, openInventory, seedAll, sql, tableRows } from './support';

/**
 * AI QA map `inventory`, sections "search" and "paging (client side)": the search box and its debounce, what the shop search
 * returns (typos, archived rows, only this shop), the address it writes, odd text, the states of the table while a page loads.
 * The search index is filled from the outbox a moment after a product is saved, so reads of it poll.
 */

const INDEX_WAIT = { timeout: 90_000 };
const search = (page: import('@playwright/test').Page) => page.getByLabel('Search your products');
/** Asserts the status tabs and the Stock select; on a phone they sit in the Filters sheet, which is opened and closed around the check. */
async function expectFilters(page: import('@playwright/test').Page, state: 'disabled' | 'enabled') {
  const phone = (page.viewportSize()?.width ?? 1280) < 1024;
  if (phone) await page.getByRole('button', { name: /Filters/ }).click();
  const check = state === 'disabled' ? 'toBeDisabled' : 'toBeEnabled';
  await expect(page.getByRole('tab', { name: 'Active' }))[check]();
  await expect(page.getByRole('tab', { name: 'Archived' }))[check]();
  await expect(page.getByLabel('Stock'))[check]();
  if (phone) await page.getByRole('button', { name: 'Done' }).click();
}

const products = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Products' });

test.describe('Inventory search', () => {
  test('[inventory.search.box, inventory.search.url-write, inventory.search.api-call, inventory.search.typo-match, inventory.search.tabs-stock-disabled, inventory.search.lag-hint, inventory.list.search-active-badge, inventory.search.clear-box] a typo finds active and archived products, writes q to the address and locks the filters', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.box,inventory.search.url-write,inventory.search.api-call,inventory.search.typo-match,inventory.search.tabs-stock-disabled,inventory.search.lag-hint,inventory.list.search-active-badge,inventory.search.clear-box' });
    const { member, shopId } = await ownerWithShop(page);
    const [, old] = await seedAll(member, shopId, [{ title: 'Ceramic mug' }, { title: 'Ceramic mug old' }, { title: 'Walnut spoon' }]);
    await archiveAll(member, shopId, [old]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    const box = search(page);
    await expect(box).toHaveAttribute('type', 'search');
    await expect(box).toHaveAttribute('autocomplete', 'off');
    const history = await page.evaluate(() => window.history.length);

    await box.pressSequentially('ceramc mug');
    await expect(box).toHaveValue('ceramc mug');
    // typing shows at once and locks the filters, but nothing is sent or written to the address before 300 ms of silence
    await expectFilters(page, 'disabled');
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);
    await expect(page).toHaveURL(/[?&]q=ceramc\+mug/);
    expect(await page.evaluate(() => window.history.length)).toBe(history);
    await expect(page.getByText('Search covers all products.')).toBeVisible();
    await expect(page.getByText('Search results can take a few seconds to include new products.')).toBeVisible();

    await expect(async () => {
      await page.reload();
      expect((await tableRows(page)).map((cells) => cells[0]).sort()).toEqual(['Ceramic mug', 'Ceramic mug old']);
    }).toPass(INDEX_WAIT);
    const rows = await tableRows(page);
    expect(rows.find((cells) => cells[0] === 'Ceramic mug')?.[3]).toContain('Active');
    expect(rows.find((cells) => cells[0] === 'Ceramic mug old')?.[3]).toBe('Archived');
    const calls = api.matching('GET', new RegExp(`^/api/shops/${shopId}/products/search$`));
    expect(calls.length).toBeGreaterThan(0);

    const indexed = await sql<{ title: string; status: string }>(`SELECT title, status FROM "SearchShopProduct" WHERE "shopId" = $1 AND title LIKE 'Ceramic%'`, [shopId]);
    expect(indexed.map((row) => `${row.title}:${row.status}`).sort()).toEqual(['Ceramic mug old:ARCHIVED', 'Ceramic mug:ACTIVE']);

    // emptying the box by hand returns to the browse list and unlocks the filters
    await box.fill('');
    await expect(page).not.toHaveURL(/[?&]q=/);
    await expectFilters(page, 'enabled');
    await expect(page.getByRole('rowheader', { name: 'Walnut spoon' })).toBeVisible();
  });

  test('[inventory.search.api-call] the search call carries only q and limit', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.api-call' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Query Shape Mug' }]);
    await openInventory(page, member, shopId);
    const sent = page.waitForRequest((request) => /\/products\/search/.test(request.url()));
    await search(page).fill('Query Shape');
    const url = new URL((await sent).url());
    expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'q']);
    expect(url.searchParams.get('limit')).toBe('20');
  });

  test('[inventory.search.only-own-shop] a title that exists only in another shop gives no hit, and the other shop\'s search path is closed', async ({ page, browser }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.only-own-shop' });
    const title = uniqueTitle('Foreign Gizmo');
    const other = await browser.newContext();
    const foreign = await ownerWithShop(await other.newPage(), [{ title }]);
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Own Thing' }]);
    await expect.poll(async () => (await sql(`SELECT 1 FROM "SearchShopProduct" WHERE "shopId" = $1 AND title = $2`, [foreign.shopId, title])).length, INDEX_WAIT).toBe(1);
    await openInventory(page, member, shopId, `?q=${encodeURIComponent(title)}`);
    await expect(products(page).getByText(`No products match “${title}”.`)).toBeVisible();
    const token = await tokenOf(member);
    const own = await sellerCall('GET', `/api/shops/${shopId}/products/search?q=Foreign&limit=20`, undefined, token);
    expect([own.status, own.data.items]).toEqual([200, []]);
    const theirs = await sellerCall('GET', `/api/shops/${foreign.shopId}/products/search?q=Foreign&limit=20`, undefined, token);
    expect(theirs.status).toBe(404);
    await other.close();
  });

  test('[inventory.search.empty-result, inventory.search.whitespace-only, inventory.search.special-characters] no match offers Clear search; spaces mean no search; odd text is plain text', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.empty-result,inventory.search.whitespace-only,inventory.search.special-characters' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Plain Mug' }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await search(page).fill('   ');
    await expectFilters(page, 'enabled');
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);
    await expect(page.getByRole('rowheader', { name: 'Plain Mug' })).toBeVisible();
    expect(api.count('GET', /\/products\/search$/)).toBe(0);

    for (const text of ["'", '"', '%', '_', '\\', '<script>alert(1)</script>', '😀', `'; DROP TABLE "Product"; --`]) {
      await search(page).fill(text);
      await expect(products(page).getByText(`No products match “${text}”.`)).toBeVisible();
      await expect(products(page).getByRole('button', { name: 'Clear search' })).toBeVisible();
    }
    await products(page).getByRole('button', { name: 'Clear search' }).click();
    await expect(search(page)).toHaveValue('');
    await expect(page).not.toHaveURL(/[?&]q=/);
    await expect(page.getByRole('rowheader', { name: 'Plain Mug' })).toBeVisible();
    expect(api.matching('GET', /\/products\/search$/).every((entry) => entry.status === 200)).toBe(true);
    const stored = await sql<{ n: string }>(`SELECT count(*) AS n FROM "Product" WHERE "shopId" = $1`, [shopId]);
    expect(stored[0].n).toBe('1');
  });

  test('[inventory.search.long-text] text longer than the search allows (100) is explained, not shown as a vague field error', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.long-text' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Long Mug' }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await search(page).fill('a'.repeat(101));
    await expect.poll(() => api.matching('GET', /\/products\/search$/).map((entry) => entry.status)).toContain(400);
    await expect(products(page)).toContainText(/too long|at most 100|100 characters/i);
  });

  test('[inventory.search.back-button] Back returns to the earlier address and the box shows its text', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.back-button' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Back Mug' }]);
    await openInventory(page, member, shopId, '?q=mug');
    await expect(search(page)).toHaveValue('mug');
    await page.goto(`${shopPath(shopId, 'inventory')}?q=spoon`);
    await expect(search(page)).toHaveValue('spoon');
    await page.goBack();
    await expect(page).toHaveURL(/[?&]q=mug$/);
    await expect(search(page)).toHaveValue('mug');
    // typing replaces the address (no new history entry): Back leaves the page instead of undoing the typing
    await openInventory(page, member, shopId);
    await search(page).fill('Back');
    await expect(page).toHaveURL(/[?&]q=Back$/);
    await page.goBack();
    await expect(page).not.toHaveURL(/inventory\?q=Back/);
  });

  test('[inventory.search.new-product-lag] a product created a moment ago is found once the index has caught up', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.new-product-lag' });
    const { member, shopId } = await ownerWithShop(page, []);
    const title = uniqueTitle('Fresh Lantern');
    await seedAll(member, shopId, [{ title }]);
    await openInventory(page, member, shopId, `?q=${encodeURIComponent(title)}`);
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole('rowheader', { name: title })).toBeVisible({ timeout: 2_000 });
    }).toPass(INDEX_WAIT);
    const indexed = await sql(`SELECT 1 FROM "SearchShopProduct" WHERE "shopId" = $1 AND title = $2`, [shopId, title]);
    expect(indexed).toHaveLength(1);
  });
});

test.describe('Inventory table while pages change', () => {
  test('[inventory.paging.empty-last-page] a cursor page that lost its rows says so and offers the first page', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.paging.empty-last-page' });
    const member = await register(page);
    const { shopId } = await openShopByApi(member);
    await makePro(shopId);
    const ids = await seedAll(member, shopId, Array.from({ length: 21 }, (_, i) => ({ title: `Edge ${String(i + 1).padStart(2, '0')}` })));
    await openInventory(page, member, shopId);
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page.getByRole('rowheader', { name: 'Edge 01' })).toBeVisible();
    const pageTwo = page.url();
    await archiveAll(member, shopId, [ids[0]]);
    await page.goto(pageTwo);
    await expect(products(page).getByText('No products on this page.')).toBeVisible();
    await expect(products(page).getByRole('link', { name: 'First page' })).toHaveAttribute('href', shopPath(shopId, 'inventory'));
  });

  test('[inventory.list.row-stock-number] the stock number is plain text: clicking it opens nothing', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.list.row-stock-number' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Stock Text Mug', quantity: 7 }]);
    await openInventory(page, member, shopId);
    await page.getByRole('row').filter({ hasText: 'Stock Text Mug' }).getByText('7', { exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
  });

  test('[inventory.paging.busy-dimmed] while the next page loads the old rows stay, the table is busy and dimmed, and the paging links are hidden', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.paging.busy-dimmed' });
    const member = await register(page);
    const { shopId } = await openShopByApi(member);
    await makePro(shopId);
    await seedAll(member, shopId, Array.from({ length: 21 }, (_, n) => ({ title: `Pager ${String(n).padStart(2, '0')}` })));
    await openInventory(page, member, shopId);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(/inventory\?.*cursor=/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('table')).toHaveClass(/opacity-60/);
    await expect(page.getByRole('rowheader', { name: 'Pager 20' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
    release();
    await expect(page.getByRole('rowheader', { name: 'Pager 00' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveAttribute('aria-busy', 'false');
  });
});
