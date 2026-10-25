/**
 * W04 inventory page, read side. The first block is the journey (AS-33, AS-36, AS-30, AS-40); the rest are the AI QA checks merged into the
 * one suite: list, paging, search, filters, states, row menu. Phone-layout tests carry @phone, all others @desktop.
 */
import { expect, type Page, test } from '@playwright/test';
import { openFiltersIfCollapsed, register, seedProduct, sellerCall, shopPath } from './helpers';
import { openShopByApi } from './seller-setup';
import { archiveAll, makePro, openInventory, proOwner, type Seed, seedAll, sharedShop, sql, tableRows, waitIndexed } from './support/inventory';
import { archiveByApi, mainText, ownerWithShop, setSuspended, tokenOf, uniqueTitle, UNKNOWN_ID, watchApi } from './seller/cross-cutting/support';

const TITLE = 'Handmade Ceramic Mug';
const rowOf = (page: Page, title: string) => page.getByRole('row').filter({ hasText: title });

test.describe('Seller inventory', () => {
  test('W04 AS-33, AS-36, AS-30, AS-40 @desktop: owner adds, finds, edits and archives a product', async ({ page }) => {
    const member = await register(page);
    const { shopId } = await openShopByApi(member);
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
      // the box reports after 300 ms of silence: wait until the empty text reached the address, or both fills collapse into one
      // unchanged `q` and the search is never asked again
      await search.fill('');
      await expect(page).not.toHaveURL(/q=/, { timeout: 3_000 });
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

test.describe('Inventory list and paging', () => {
  const SPECIAL: Seed[] = [
    { title: 'Stock zero', quantity: 0 },
    { title: 'Stock one', quantity: 1, currency: 'JPY' },
    { title: 'Stock five', quantity: 5, currency: 'KWD' },
    { title: 'Stock six', quantity: 6, currency: 'USD' },
    { title: 'Stock max', quantity: 1_000_000_000 },
    { title: '<b>Bold</b><script>alert(1)</script>', quantity: 3 },
    { title: 'Cent thing', quantity: 8, priceMinor: 1 },
    { title: 'Max price', quantity: 8, priceMinor: 10_000_000_000 },
    { title: `Long name ${'wordy '.repeat(30)}`.trim(), quantity: 9 },
  ];
  const BULK: Seed[] = Array.from({ length: 36 }, (_, i) => ({ title: `Bulk ${String(i + 1).padStart(2, '0')}`, quantity: 10 + i }));

  test.describe.configure({ mode: 'serial' });

  let member: { email: string };
  let shopId: string;
  let archivedTitles: string[];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    member = await register(page);
    ({ shopId } = await openShopByApi(member));
    await makePro(shopId);
    await seedAll(member, shopId, [...SPECIAL, ...BULK]);
    // archived products at the stock boundaries (an archived row says "Archived" whatever its stock)
    const archived: Seed[] = [0, 1, 5, 6, 50, 1_000_000_000].map((quantity) => ({ title: `Archived stock ${quantity}`, quantity }));
    archivedTitles = archived.map((seed) => seed.title);
    await archiveAll(member, shopId, await seedAll(member, shopId, archived));
    await context.close();
  });

  const rowFor = (rows: string[][], title: string) => {
    const row = rows.find((cells) => cells[0] === title);
    expect(row, `row "${title}" in ${JSON.stringify(rows.map((cells) => cells[0]))}`).toBeTruthy();
    return row as string[];
  };

  /** Every row of the three pages, following the "Next page" links. */
  async function allActiveRows(page: import('@playwright/test').Page) {
    const pages: string[][][] = [];
    await openInventory(page, member, shopId);
    for (;;) {
      const rows = await tableRows(page);
      pages.push(rows);
      const next = page.getByRole('link', { name: 'Next page' });
      if (!(await next.count())) break;
      await next.click();
      await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
      await expect.poll(async () => (await tableRows(page))[0]?.[0]).not.toBe(rows[0][0]);
    }
    return pages;
  }

  test('W04 AS-28 @desktop: 45 products come as 20, 20 and 5, newest first, equal to the database', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.list.page-size-20,inventory.list.order-newest-first,inventory.list.row-name,inventory.list.row-stock-number,inventory.paging.next-page,inventory.paging.first-page,inventory.paging.last-page-no-next' });
    const pages = await allActiveRows(page);
    expect(pages.map((rows) => rows.length)).toEqual([20, 20, 5]);
    const shown = pages.flat();
    expect(new Set(shown.map((cells) => cells[0])).size).toBe(45);
    const stored = await sql<{ title: string; quantity: number }>(`SELECT title, quantity FROM "Product" WHERE "shopId" = $1 AND status = 'ACTIVE' ORDER BY "createdAt" DESC, id DESC`, [shopId]);
    expect(shown.map((cells) => cells[0])).toEqual(stored.map((row) => row.title));
    expect(shown.map((cells) => cells[2])).toEqual(stored.map((row) => String(row.quantity)));
    // the paging links keep the address clean: "First page" has no cursor, the last page has no "Next page"
    await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
    expect(await page.getByRole('link', { name: 'First page' }).getAttribute('href')).toBe(shopPath(shopId, 'inventory'));
  });

  test('W04 AS-43 @desktop: a title with markup is shown as text and a long title wraps without sideways scroll', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.list.row-name' });
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const pages = await allActiveRows(page);
    const markup = rowFor(pages.flat(), '<b>Bold</b><script>alert(1)</script>');
    expect(markup[0]).toBe('<b>Bold</b><script>alert(1)</script>');
    await expect(page.locator('tbody th b')).toHaveCount(0);
    expect(dialogs).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('W04 AS-39 @desktop: money follows the row currency and labels follow the thresholds', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.list.row-price,inventory.list.row-status-label,inventory.list.stock-boundaries' });
    const rows = (await allActiveRows(page)).flat();
    expect(rowFor(rows, 'Stock zero').slice(1)).toEqual(['€24.50', '0', 'Out of stock']);
    expect(rowFor(rows, 'Stock one').slice(1)).toEqual(['¥2,450', '1', 'Low stock']);
    expect(rowFor(rows, 'Stock five').slice(1)).toEqual(['KWD 2.450', '5', 'Low stock']);
    expect(rowFor(rows, 'Stock six').slice(1)).toEqual(['$24.50', '6', 'In stock']);
    expect(rowFor(rows, 'Stock max').slice(1)).toEqual(['€24.50', '1000000000', 'In stock']);
    expect(rowFor(rows, 'Cent thing')[1]).toBe('€0.01');
    expect(rowFor(rows, 'Max price')[1]).toBe('€100,000,000.00');
    const stored = await sql<{ priceMinor: string; currency: string }>(`SELECT "priceMinor", currency FROM "Product" WHERE "shopId" = $1 AND title = 'Stock five'`, [shopId]);
    expect(stored[0]).toEqual({ priceMinor: '2450', currency: 'KWD' });
    // archived rows say "Archived" at every stock level
    await openInventory(page, member, shopId, '?status=ARCHIVED');
    const archived = await tableRows(page);
    expect(archived.map((cells) => cells[0]).sort()).toEqual([...archivedTitles].sort());
    for (const cells of archived) expect(cells[3], cells[0]).toBe('Archived');
    expect(rowFor(archived, 'Archived stock 1000000000')[2]).toBe('1000000000');
  });

  test('W04 AS-28 @desktop: the list holds only this shop\'s ACTIVE products', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.list.only-own-shop' });
    const token = await tokenOf(member);
    const read = await sellerCall('GET', `/api/shops/${shopId}/products?status=ACTIVE&limit=100`, undefined, token);
    expect(read.status).toBe(200);
    const items = read.data.items as { shopId: string; status: string }[];
    expect(items).toHaveLength(45);
    for (const item of items) expect([item.shopId, item.status]).toEqual([shopId, 'ACTIVE']);
    const foreign = await sql<{ n: string }>(`SELECT count(*) AS n FROM "Product" WHERE "shopId" = $1`, [shopId]);
    expect(Number(foreign[0].n)).toBe(45 + archivedTitles.length);
    await openInventory(page, member, shopId);
    await expect(page.getByRole('row')).toHaveCount(21);
  });

  test('W04 AS-28 @desktop: "Next page" is a link that keeps the stock filter in the address', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.paging.next-page' });
    await openInventory(page, member, shopId, '?inStock=true');
    const next = page.getByRole('link', { name: 'Next page' });
    const href = new URL((await next.getAttribute('href')) ?? '', 'http://localhost');
    expect(href.searchParams.get('inStock')).toBe('true');
    expect(href.searchParams.get('cursor')).toBeTruthy();
    await next.click();
    await expect(page).toHaveURL(/cursor=/);
    expect(new URL(page.url()).searchParams.get('inStock')).toBe('true');
  });

  test('W04 AS-89 @desktop: an unknown cursor or one from another filter shows the refusal with a way back', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.paging.invalid-cursor,inventory.paging.cursor-other-filter' });
    await openInventory(page, member, shopId);
    const cursor = new URL((await page.getByRole('link', { name: 'Next page' }).getAttribute('href')) ?? '', 'http://localhost').searchParams.get('cursor') ?? '';
    for (const query of ['?cursor=aaaa', `?cursor=${cursor}&inStock=true`, `?cursor=${cursor}&inStock=false`, `?cursor=${cursor}&status=ARCHIVED`]) {
      await page.goto(`${shopPath(shopId, 'inventory')}${query}`);
      await expect(page.getByText('That page link is no longer valid.')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute('href', shopPath(shopId, 'inventory'));
    }
    // a cursor with illegal characters is dropped: the first page shows
    await page.goto(`${shopPath(shopId, 'inventory')}?cursor=${encodeURIComponent('a!b c<>')}`);
    await expect(page.getByRole('row')).toHaveCount(21);
  });
});

test.describe('Inventory search', () => {
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
    test('W04 AS-30 @desktop: a typo finds active and archived products, writes q to the address and locks the filters', async ({ page }) => {
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

      // the outbox poller fills the index in batches: wait on the index row itself (cheap database poll), then read the page once
      await waitIndexed(shopId, 3);
      await page.reload();
      expect((await tableRows(page)).map((cells) => cells[0]).sort()).toEqual(['Ceramic mug', 'Ceramic mug old']);
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

    test('W04 AS-30 @desktop: the search call carries only q and limit', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.api-call' });
      const { member, shopId } = await sharedShop(page, [{ title: 'Query Shape Mug' }]);
      await openInventory(page, member, shopId);
      const sent = page.waitForRequest((request) => /\/products\/search/.test(request.url()));
      await search(page).fill('Query Shape');
      const url = new URL((await sent).url());
      expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'q']);
      expect(url.searchParams.get('limit')).toBe('20');
    });

    test('W04 AS-30 @desktop: a title that exists only in another shop gives no hit, and the other shop\'s search path is closed', async ({ page, browser }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.only-own-shop' });
      const title = uniqueTitle('Foreign Gizmo');
      const other = await browser.newContext();
      const foreign = await ownerWithShop(await other.newPage(), [{ title }]);
      const { member, shopId } = await ownerWithShop(page, [{ title: 'Own Thing' }]);
      await waitIndexed(foreign.shopId, 1);
      await openInventory(page, member, shopId, `?q=${encodeURIComponent(title)}`);
      await expect(products(page).getByText(`No products match “${title}”.`)).toBeVisible();
      const token = await tokenOf(member);
      const own = await sellerCall('GET', `/api/shops/${shopId}/products/search?q=Foreign&limit=20`, undefined, token);
      expect([own.status, own.data.items]).toEqual([200, []]);
      const theirs = await sellerCall('GET', `/api/shops/${foreign.shopId}/products/search?q=Foreign&limit=20`, undefined, token);
      expect(theirs.status).toBe(404);
      await other.close();
    });

    test('W04 AS-32 @desktop: no match offers Clear search; spaces mean no search; odd text is plain text', async ({ page }) => {
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

    test('W04 AS-30 @desktop: text longer than the search allows (100) is explained, not shown as a vague field error', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.long-text' });
      const { member, shopId } = await sharedShop(page, [{ title: 'Long Mug' }]);
      await openInventory(page, member, shopId);
      const api = watchApi(page);
      await search(page).fill('a'.repeat(101));
      await expect.poll(() => api.matching('GET', /\/products\/search$/).map((entry) => entry.status)).toContain(400);
      await expect(products(page)).toContainText(/too long|at most 100|100 characters/i);
    });

    test('W04 AS-30 @desktop: Back returns to the earlier address and the box shows its text', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.back-button' });
      const { member, shopId } = await sharedShop(page, [{ title: 'Back Mug' }]);
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

    test('W04 AS-30 @desktop: a product created a moment ago is found once the index has caught up', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.new-product-lag' });
      const { member, shopId } = await ownerWithShop(page, []);
      const title = uniqueTitle('Fresh Lantern');
      await seedAll(member, shopId, [{ title }]);
      await openInventory(page, member, shopId, `?q=${encodeURIComponent(title)}`);
      await waitIndexed(shopId, 1);
      await page.reload();
      await expect(page.getByRole('rowheader', { name: title })).toBeVisible();
      const indexed = await sql(`SELECT 1 FROM "SearchShopProduct" WHERE "shopId" = $1 AND title = $2`, [shopId, title]);
      expect(indexed).toHaveLength(1);
    });
  });

  test.describe('Inventory table while pages change', () => {
    test('W04 AS-28 @desktop: a cursor page that lost its rows says so and offers the first page', async ({ page }) => {
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

    test('W04 AS-28 @desktop: the stock number is plain text: clicking it opens nothing', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.list.row-stock-number' });
      const { member, shopId, titles: [mug] } = await sharedShop(page, [{ title: 'Stock Text Mug', quantity: 7 }]);
      await openInventory(page, member, shopId);
      await page.getByRole('row').filter({ hasText: mug }).getByText('7', { exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
    });

    test('W04 AS-28 @desktop: while the next page loads the old rows stay, the table is busy and dimmed, and the paging links are hidden', async ({ page }) => {
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
});

test.describe('Inventory tabs and filters', () => {
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
    test('W04 AS-29 @desktop: Active is the default and not in the address; Archived writes ?status=ARCHIVED as a history entry; the selected tab does nothing', async ({ page }) => {
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


    test('W04 AS-29 @desktop: the Stock select writes inStock, resets the cursor, and the rows equal the database', async ({ page }) => {
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


    test('W04 AS-29 @desktop: a repeated status or stock value falls back to the default, in the server render and in the page (P2F2)', async ({ page }) => {
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

    test('W04 AS-29 @desktop: a search address of more than 200 characters falls back and never errors (P1F3)', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.invalid-url-values-q' });
      await openInventory(page, member, shopId, `?q=${'z'.repeat(250)}`);
      await page.waitForTimeout(1500);
      await expect(products(page).getByText(/Check this field|went wrong|couldn't load/)).toHaveCount(0);
    });

    test('W04 AS-29 @desktop: an address with status, stock and a cursor shows the same view after a reload and in a second tab', async ({ page, context }) => {
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
    test('W04 AS-32 @desktop: no match: the filter text with Clear filters; Archived with nothing says "No archived products." without a button, also with the Stock filter', async ({ page }) => {
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
    test('W04 AS-29 @phone: the Filters button counts the set filters, the sheet holds them, Clear filters goes to the plain address, Escape returns focus', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.phone-sheet,inventory.filter.clear-filters,inventory.filter.sheet-keyboard' });
      await page.setViewportSize({ width: 390, height: 844 });
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

    test('W04 AS-29 @desktop: from 641 px up the filters are inline, there is no Filters button, and the Stock label is tied to the select', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.desktop-inline' });
      await openInventory(page, member, shopId);
      await expect(page.getByRole('button', { name: /^Filters/ })).toBeHidden();
      await expect(page.locator('[data-filters-inline]')).toBeVisible();
      await expect(page.locator('label[for="inventory-stock"]')).toHaveText('Stock');
      await expect(page.locator('select#inventory-stock')).toBeVisible();
      await page.setViewportSize({ width: 641, height: 800 });
      await expect(page.getByRole('button', { name: /^Filters/ })).toBeHidden();
    });

    test('W04 AS-29 @desktop: at exactly 640 px (the phone limit) the filters sit in the sheet (P2F3)', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.desktop-inline-640' });
      await openInventory(page, member, shopId);
      await page.setViewportSize({ width: 640, height: 800 });
      await expect(page.getByRole('button', { name: /^Filters/ })).toBeVisible();
    });

    test('W04 AS-29 @phone: the Stock select inside the sheet has its own accessible name (P2F1)', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.filter.phone-sheet-label' });
      await page.setViewportSize({ width: 390, height: 844 });
      await openInventory(page, member, shopId);
      await openFilters(page);
      await expect(page.getByRole('dialog', { name: 'Filters' }).locator('select')).toHaveAccessibleName('Stock');
    });
  });
});

test.describe('Inventory page', () => {
  test.describe('Inventory page: opening it', () => {
    test('W04 AS-28 @desktop: the page shows its heading, the shop and a labelled table', async ({ page }) => {
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

    test('W04 AS-84 @desktop: a signed-out visitor is sent to the sign-in page with the full address as returnTo', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.signed-out' });
      const response = await page.goto(`${shopPath(UNKNOWN_ID, 'inventory')}?q=abc&status=ARCHIVED`);
      expect(await response?.text()).not.toContain('Products of');
      await expect(page).toHaveURL(/\/login\?returnTo=/);
      expect(new URL(page.url()).searchParams.get('returnTo')).toBe(`${shopPath(UNKNOWN_ID, 'inventory')}?q=abc&status=ARCHIVED`);
    });

    test('W04 AS-08 @desktop: the old address goes to the only shop, to the picker for two shops, to sign-in when signed out', async ({ page, browser }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.legacy-redirect' });
      const anonymous = await browser.newContext();
      const anonymousPage = await anonymous.newPage();
      await anonymousPage.goto('/dashboard/seller/inventory');
      await expect(anonymousPage).toHaveURL(/\/login\?returnTo=%2Fdashboard%2Fseller%2Finventory$/);
      await anonymous.close();

      const { shopId, member } = await ownerWithShop(page);
      await page.goto('/dashboard/seller/inventory');
      await expect(page).toHaveURL(new RegExp(`${shopPath(shopId, 'inventory')}$`));

      const { openSecondShop } = await import('./seller/cross-cutting/support');
      await openSecondShop(member);
      await page.goto('/dashboard/seller/inventory');
      await expect(page).toHaveURL(/\/dashboard\/seller$/);
      await expect(page.getByRole('heading', { name: 'Your shops' })).toBeVisible();
    });

    test('W04 AS-85 @desktop: a malformed, unknown or foreign shop gives the same not-found page and no products call', async ({ page, browser }) => {
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

    test('W04 AS-98 @desktop: the Inventory entry marks the current page, also in the phone menu', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.menu-entry' });
      const { shopId, member } = await sharedShop(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await openInventory(page, member, shopId);
      await expect(page.getByRole('link', { name: 'Inventory' })).toHaveAttribute('aria-current', 'page');
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole('link', { name: 'Inventory' })).toBeHidden();
      await page.getByRole('region', { name: 'Shop bar' }).getByRole('button', { name: 'Open seller menu' }).click();
      await expect(page.getByRole('dialog').getByRole('link', { name: 'Inventory' })).toHaveAttribute('aria-current', 'page');
    });

    test('W04 AS-98 @phone: the two phone menu buttons have different accessible names', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.menu-entry-extra-1' });
      const { shopId, member } = await sharedShop(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await openInventory(page, member, shopId);
      const names = await page.getByRole('button', { name: /menu/i }).evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
      expect(new Set(names).size, `menu buttons: ${names.join(' | ')}`).toBe(names.length);
    });


    test('W04 AS-97 @phone: at 390 px nothing scrolls sideways and the controls are at least 44 px high', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.page.phone-layout' });
      const { shopId, member, titles: [mug] } = await sharedShop(page, [{ title: 'Phone Mug' }]);
      await page.setViewportSize({ width: 390, height: 844 });
      await openInventory(page, member, shopId);
      await expect(page.getByRole('rowheader', { name: mug, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.getByRole('table').evaluate((table) => getComputedStyle(table).display)).toBe('block');
      for (const control of [page.getByRole('searchbox'), page.getByRole('button', { name: /Filters/ }), page.getByRole('button', { name: 'Add product' }).first(), page.getByRole('button', { name: `Actions for ${mug}` })]) {
        const box = await control.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    });
  });
});

test.describe('Inventory empty and error states', () => {
  const region = (page: Page) => page.getByRole('region', { name: 'Products' });
  const LIST = (url: URL) => /^\/api\/shops\/[^/]+\/products$/.test(url.pathname);
  const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'x', title: 'Boom', status, code, requestId: 'req-state-42', detail: 'SELECT * FROM "Product" at /usr/src/app/product.service.ts:88', ...extra });
  /** The browser goes offline and back: the open seller queries refetch once (the page's own rule). */
  async function blink(page: Page) {
    await page.context().setOffline(true);
    await expect(page.getByText("You're offline. Changes can't be saved.")).toBeVisible();
    await page.context().setOffline(false);
  }

  test.describe('Inventory empty and error states', () => {


    test('W04 AS-89 @desktop: a 5xx on the list read shows the words, a reference with Copy and no technical text; it is retried at most twice; Try again refetches', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.error.read-fail,inventory.error.5xx-reference' });
      const { member, shopId, titles: [mug] } = await sharedShop(page, [{ title: 'State Mug' }]);
      await openInventory(page, member, shopId);
      const api = watchApi(page);
      const failing = (route: import('@playwright/test').Route) => route.fulfill({ status: 503, contentType: 'application/problem+json', body: problem(503, 'internal_error') });
      await page.route((url) => LIST(url), failing);
      await blink(page);
      await expect(region(page).getByRole('alert')).toBeVisible({ timeout: 30_000 });
      const text = await region(page).innerText();
      expect(text).toMatch(/Something went wrong on our side\.|We couldn't load this right now/);
      expect(text).toContain('req-state-42');
      await expect(region(page).getByRole('button', { name: 'Copy reference' })).toBeVisible();
      expect(text).not.toMatch(/SELECT|product\.service|\.ts:|at \/usr|stack/i);
      expect(api.count('GET', /\/products$/), 'a 5xx is retried at most twice').toBeLessThanOrEqual(3);
      // Try again goes to the server again; the server is healthy now
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      api.reset();
      await region(page).getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByRole('rowheader', { name: mug, exact: true })).toBeVisible();
      expect(api.count('GET', /\/products$/)).toBe(1);
    });

    test('W04 AS-89 @desktop: a 4xx on the list read is shown once and is not retried by the query', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.error.read-fail-4xx' });
      const { member, shopId } = await sharedShop(page, [{ title: 'Four Mug' }]);
      await openInventory(page, member, shopId);
      const api = watchApi(page);
      await page.route((url) => LIST(url), (route) => route.fulfill({ status: 403, contentType: 'application/problem+json', body: problem(403, 'permission_denied') }));
      await blink(page);
      await expect(region(page).getByRole('alert')).toBeVisible();
      const seen = api.count('GET', /\/products$/);
      await page.waitForTimeout(4000); // longer than the two retry delays a 5xx would have used
      expect(api.count('GET', /\/products$/), 'no retry of a 4xx').toBe(seen);
    });

  });
});

test.describe('Inventory search paging and row menu', () => {
  const search = (page: Page) => page.getByLabel('Search your products');
  const region = (page: Page) => page.getByRole('region', { name: 'Products' });
  const menuButton = (page: Page, title: string) => page.getByRole('button', { name: `Actions for ${title}`, exact: true });
  const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 640;
  const items = (page: Page) => page.getByRole('menuitem').allInnerTexts();

  test.describe('Shop search: limits, paging and row actions', () => {
    test('W04 AS-90 @desktop: past the search limit the API answers 429 and the page shows a countdown, not a crash', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.rate-limit' });
      test.setTimeout(150_000);
      // The stack's API lets the loopback address through (RATE_LIMIT_ALLOW_IPS), so the 429 itself is stubbed; the page's reaction is what is checked.
      const { member, shopId } = await ownerWithShop(page, [{ title: 'Limit Mug' }]);
      await openInventory(page, member, shopId);
      await page.route(/\/products\/search/, (route) => route.fulfill({ status: 429, contentType: 'application/problem+json', headers: { 'Retry-After': '20' }, body: JSON.stringify({ type: 'x', title: 'Too many', status: 429, code: 'rate_limited' }) }));
      await search(page).fill('Limit');
      await expect(region(page).getByText(/^Too many requests\. Try again in \d+ s\.$/)).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
      await expect(search(page)).toHaveValue('Limit');
    });

    test('W04 AS-30 @desktop: 25 hits come as 20 and 5 with a cursor bound to the text; an archived hit offers only Restore (version read first), an active one the full menu', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.paging,inventory.search.row-actions' });
      test.setTimeout(180_000);
      const { member, shopId } = await proOwner(page);
      const token = await tokenOf(member);
      const ids = await seedAll(member, shopId, Array.from({ length: 25 }, (_, i) => ({ title: `Zebra ${String(i).padStart(2, '0')}` })));
      await archiveByApi(token, shopId, ids[0]); // Zebra 00 is archived
      await waitIndexed(shopId, 25, { archived: ids[0] });
      await openInventory(page, member, shopId, '?q=Zebra');
      await expect(region(page).getByRole('row')).toHaveCount(21);
      const first = await page.locator('tbody tr').evaluateAll((rows) => rows.map((row) => row.children[0].textContent));
      const next = page.getByRole('link', { name: 'Next page' });
      const href = (await next.getAttribute('href')) ?? '';
      expect(new URL(href, page.url()).searchParams.get('q')).toBe('Zebra');
      const cursor = new URL(href, page.url()).searchParams.get('cursor') ?? '';
      expect(cursor.length).toBeGreaterThan(5);
      await next.click();
      await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
      const second = await page.locator('tbody tr').evaluateAll((rows) => rows.map((row) => row.children[0].textContent));
      expect(second.length).toBe(5);
      expect(new Set([...first, ...second]).size).toBe(25);
      await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
      // the cursor belongs to the text: another text with the same cursor is refused
      const mixed = await sellerCall('GET', `/api/shops/${shopId}/products/search?q=Other&limit=20&cursor=${encodeURIComponent(cursor)}`, undefined, token);
      expect([mixed.status, mixed.data.code], JSON.stringify(mixed.data)).toEqual([422, 'invalid_cursor']);

      // row actions of a search result
      await openInventory(page, member, shopId, '?q=Zebra 00');
      await expect(page.getByRole('rowheader', { name: 'Zebra 00' })).toBeVisible();
      await menuButton(page, 'Zebra 00').click();
      expect(await items(page)).toEqual(['Restore']);
      await page.keyboard.press('Escape');
      await openInventory(page, member, shopId, '?q=Zebra 01');
      await menuButton(page, 'Zebra 01').click();
      expect(await items(page)).toEqual(['Edit', 'Adjust stock', 'Photos and video', 'Edit together', 'Archive']);
      await page.keyboard.press('Escape');

      // Restore from a search row: the version is read first, then one restore
      await openInventory(page, member, shopId, '?q=Zebra 00');
      const api = watchApi(page);
      await menuButton(page, 'Zebra 00').click();
      await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
      await expect(page.getByText('Product restored')).toBeVisible();
      expect(api.count('GET', new RegExp(`/products/${ids[0]}$`))).toBe(1);
      expect(api.count('POST', new RegExp(`/products/${ids[0]}/restore$`))).toBe(1);
      expect((await sql(`SELECT status, version FROM "Product" WHERE id = $1`, [ids[0]]))[0]).toMatchObject({ status: 'ACTIVE', version: 3 });
    });
  });

  test.describe('Row menu', () => {
    test('W04 AS-94 @desktop: the trigger is named after the row, opens with Enter/Space, arrows move, Escape returns focus; items by status; Edit and Adjust stock open their parts', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.trigger,inventory.menu.active-items,inventory.menu.archived-items,inventory.menu.edit-item,inventory.menu.adjust-item,inventory.stock.popover-open' });
      let focusAfterEdit = '';
      const { member, shopId, token, productIds, titles: [menuMug, oldMug] } = await sharedShop(page, [{ title: 'Menu Mug', quantity: 4 }, { title: 'Old Mug', quantity: 2 }]);
      await archiveByApi(token, shopId, productIds[1]);
      await openInventory(page, member, shopId);
      const button = menuButton(page, menuMug);
      await expect(button).toBeVisible();
      // keyboard: Enter opens, arrows move, Escape closes and returns focus
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menu')).toBeVisible();
      expect(await items(page)).toEqual(['Edit', 'Adjust stock', 'Photos and video', 'Edit together', 'Archive']);
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitem', { name: 'Adjust stock', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused();
      expect(await page.getByRole('menuitem', { name: 'Archive', exact: true }).evaluate((node) => node.getAttribute('data-variant'))).toBe('destructive');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(button).toBeFocused();
      await page.keyboard.press('Space');
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape');

      if (isPhone(page)) {
        const card = await button.locator('xpath=ancestor::tr').boundingBox();
        const box = await button.boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeGreaterThan(((card?.x ?? 0) + (card?.width ?? 0)) - 40); // right edge
        expect((box?.y ?? 0) - (card?.y ?? 0)).toBeLessThan(40); // top
      }

      await openInventory(page, member, shopId, '?status=ARCHIVED');
      await menuButton(page, oldMug).click();
      expect(await items(page)).toEqual(['Restore']);
      await page.keyboard.press('Escape');

      // Edit opens the Edit dialog of that row
      await openInventory(page, member, shopId);
      await button.click();
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      const edit = page.getByRole('dialog', { name: 'Edit product' });
      await expect(edit).toBeVisible();
      await expect(edit.getByLabel('Title', { exact: true })).toHaveValue(menuMug);
      await page.keyboard.press('Escape');
      await expect(edit).toHaveCount(0);
      focusAfterEdit = await page.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.getAttribute('aria-label') ?? ''}`);

      // Adjust stock opens the popover on the stock cell, prefilled; closing returns focus to the menu button
      await button.click();
      await page.getByRole('menuitem', { name: 'Adjust stock', exact: true }).click();
      const popover = page.getByRole('dialog', { name: `Adjust stock of ${menuMug}` });
      await expect(popover).toBeVisible();
      await expect(popover.getByLabel('New stock')).toHaveValue('4');
      const cell = await page.getByRole('row', { name: menuMug }).locator('td, [role="cell"]').nth(2).boundingBox();
      const pop = await popover.boundingBox();
      expect(Math.abs((pop?.y ?? 0) - ((cell?.y ?? 0) + (cell?.height ?? 0))), 'popover hangs under the stock cell').toBeLessThan(200);
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      await expect(button).toBeFocused();
      test.info().annotations.push({ type: 'focus-after-edit-dialog', description: focusAfterEdit });
    });

    test('W04 AS-94 @desktop: closing the Edit dialog returns focus to the row\'s menu button (W04.R-24)', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.edit-item-focus' });
      const { member, shopId, titles: [mug] } = await sharedShop(page, [{ title: 'Focus Mug' }]);
      await openInventory(page, member, shopId);
      await menuButton(page, mug).click();
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Edit product' }).getByLabel('Title', { exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Edit product' })).toHaveCount(0);
      await expect(menuButton(page, mug)).toBeFocused();
    });

    test('W04 AS-94 @desktop: Photos and video and Edit together go to their pages', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.photos-item,inventory.menu.draft-item' });
      const { member, shopId, productIds, titles: [mug] } = await sharedShop(page, [{ title: 'Way Mug' }]);
      await openInventory(page, member, shopId);
      await menuButton(page, mug).click();
      await page.getByRole('menuitem', { name: 'Photos and video', exact: true }).click();
      await expect(page).toHaveURL(`${shopPath(shopId, `products/${productIds[0]}/media`)}`.replace(/^/, 'http://localhost:3000'));
      await openInventory(page, member, shopId);
      await menuButton(page, mug).click();
      await page.getByRole('menuitem', { name: 'Edit together', exact: true }).click();
      await expect(page).toHaveURL(`http://localhost:3000${shopPath(shopId, `products/${productIds[0]}/draft`)}`);
    });

    test('W04 AS-40 @desktop: Restore sends one request even when pressed twice, shows the toast, moves the row to Active; status ACTIVE, version +1, history row', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.restore-item,inventory.menu.restore-double-press' });
      const { member, shopId, token, productIds, titles: [mug] } = await sharedShop(page, [{ title: 'Back Mug' }]);
      await archiveByApi(token, shopId, productIds[0]);
      const before = (await sql<{ version: number }>(`SELECT version FROM "Product" WHERE id = $1`, [productIds[0]]))[0].version;
      await openInventory(page, member, shopId, '?status=ARCHIVED');
      const api = watchApi(page);
      await page.route(/\/products\/[^/]+\/restore$/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 600)); // keep the first restore running while the second is chosen
        await route.continue();
      });
      await menuButton(page, mug).click();
      await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
      // a second choice while the first runs (the menu is still reachable on the row)
      const again = menuButton(page, mug);
      if (await again.count()) {
        await again.click({ timeout: 2000 }).catch(() => undefined);
        await page.getByRole('menuitem', { name: 'Restore', exact: true }).click({ timeout: 2000 }).catch(() => undefined);
      }
      await expect(page.getByText('Product restored').first()).toBeVisible();
      await expect(page.getByRole('rowheader', { name: mug })).toHaveCount(0); // left the Archived tab
      expect(api.count('POST', /\/restore$/)).toBe(1);
      await expect(region(page).getByRole('alert')).toHaveCount(0);
      expect((await sql(`SELECT status, version FROM "Product" WHERE id = $1`, [productIds[0]]))[0]).toMatchObject({ status: 'ACTIVE', version: before + 1 });
      const history = await sql<{ fromStatus: string; toStatus: string }>(`SELECT "fromStatus", "toStatus" FROM "ProductStatusHistory" WHERE "productId" = $1 ORDER BY at`, [productIds[0]]);
      expect(history.at(-1)).toMatchObject({ fromStatus: 'ARCHIVED', toStatus: 'ACTIVE' });
      await openInventory(page, member, shopId);
      await expect(page.getByRole('rowheader', { name: mug })).toBeVisible();
    });

    test('W04 AS-40 @desktop: a failed Restore shows the problem above the list; a stale answer says the product changed elsewhere and the list refetches; 429 counts down; 5xx has a reference', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.restore-failure' });
      const { member, shopId, token, productIds, titles: [mug] } = await sharedShop(page, [{ title: 'Fail Mug' }]);
      await archiveByApi(token, shopId, productIds[0]);
      const answers: { status: number; code: string; headers?: Record<string, string>; text: RegExp }[] = [
        { status: 409, code: 'invalid_transition', text: /^This product was archived or restored elsewhere\. The list has been refreshed\.$/ },
        { status: 409, code: 'version_conflict', text: /^This product changed since you opened it\.$/ },
        { status: 403, code: 'permission_denied', text: /^You don't have access to this page\.$/ },
        { status: 429, code: 'rate_limited', headers: { 'Retry-After': '20' }, text: /^Too many requests\. Try again in \d+ s\.$/ },
        { status: 500, code: 'internal_error', text: /^Something went wrong on our side\.$/ },
      ];
      const texts: string[] = [];
      for (const answer of answers) {
        await openInventory(page, member, shopId, '?status=ARCHIVED');
        await page.route(/\/products\/[^/]+\/restore$/, (route) => route.fulfill({ status: answer.status, contentType: 'application/problem+json', headers: answer.headers, body: JSON.stringify({ type: 'x', title: 'x', status: answer.status, code: answer.code, requestId: 'req-test-123' }) }));
        const api = watchApi(page);
        await menuButton(page, mug).click();
        await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
        const shown = page.locator('#main-content').locator('p').filter({ hasText: answer.text }).first();
        await expect(shown, `${answer.status} ${answer.code}`).toBeVisible();
        texts.push(`${answer.code}: ${(await shown.innerText()).trim()}`);
        if (answer.status === 500) await expect(page.getByText('Reference: req-test-123')).toBeVisible();
        if (answer.code === 'invalid_transition') await expect.poll(() => api.count('GET', /\/products$/), { message: 'the list refetches' }).toBeGreaterThan(0);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      }
      test.info().annotations.push({ type: 'copy-seen', description: texts.join(' | ') });
      expect(await sql(`SELECT 1 FROM "Product" WHERE id = $1 AND status = 'ARCHIVED'`, [productIds[0]])).toHaveLength(1);
    });

    test('W04 AS-41 @desktop: choosing another menu item clears the previous problem alert', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.problem-cleared' });
      const { member, shopId, token, productIds, titles: [clearMug, nextMug] } = await sharedShop(page, [{ title: 'Clear Mug' }, { title: 'Next Mug' }]);
      await archiveByApi(token, shopId, productIds[0]);
      await archiveByApi(token, shopId, productIds[1]);
      await openInventory(page, member, shopId, '?status=ARCHIVED');
      await page.route(/\/products\/[^/]+\/restore$/, (route) => route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'x', status: 500, code: 'internal_error', requestId: 'req-x' }) }));
      await menuButton(page, clearMug).click();
      await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
      await expect(page.getByText('Something went wrong on our side.')).toBeVisible();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await menuButton(page, nextMug).click();
      await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
      await expect(page.getByText('Something went wrong on our side.')).toHaveCount(0); // the new action cleared the old problem
      await expect(page.getByText('Product restored')).toBeVisible();
    });

    test('W04 AS-86 @desktop: on a suspended shop the banner shows, Add product is disabled with the note, and the list stays readable (B-024: the list call answers 403)', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.suspended,inventory.add.button-suspended-closing' });
      const { member, shopId } = await proOwner(page);
      await seedAll(member, shopId, [{ title: 'Susp Mug' }]);
      await setSuspended(shopId, true);
      await openInventory(page, member, shopId);
      await expect(page.getByText(/This shop is suspended/).first()).toBeVisible();
      const add = page.getByRole('button', { name: 'Add product' }).first();
      await expect(add).toBeDisabled();
      await expect(add).toHaveAccessibleDescription(/This shop is suspended/);
      // the list must stay readable and the row menu disabled with the reason on top
      await expect(page.getByRole('rowheader', { name: 'Susp Mug' })).toBeVisible();
      await menuButton(page, 'Susp Mug').click();
      await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeDisabled();
      await expect(page.getByRole('menu')).toContainText('This shop is suspended');
    });

    test('W04 AS-86 @desktop: on a closing shop the button is disabled and the note carries the closing text', async ({ page }) => {
      test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.button-suspended-closing-deleting' });
      const { member, shopId } = await ownerWithShop(page, [{ title: 'Close Mug' }]);
      await sql(`UPDATE "Shop" SET status = 'DELETING' WHERE id = $1`, [shopId]);
      await openInventory(page, member, shopId);
      const add = page.getByRole('button', { name: 'Add product' }).first();
      await expect(add).toBeDisabled();
      await expect(add).toHaveAccessibleDescription(/This shop is being closed/);
      const status = await sellerCall('GET', `/api/shops/${shopId}/products`, undefined, await tokenOf(member));
      test.info().annotations.push({ type: 'list-status-on-closing-shop', description: String(status.status) });
      await expect(page.getByRole('rowheader', { name: 'Close Mug' })).toBeVisible();
    });
  });
});
