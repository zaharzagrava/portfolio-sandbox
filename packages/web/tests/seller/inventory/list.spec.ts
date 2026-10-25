import { expect, test } from '@playwright/test';
import { register, sellerCall, shopPath } from '../../helpers';
import { openShopByApi } from '../../seller-setup';
import { archiveAll, makePro, openInventory, seedAll, sql, tableRows, type Seed } from './support';
import { tokenOf } from '../cross-cutting/support';

/**
 * AI QA map `inventory`, sections "list" and "paging": what a row shows (name, price, stock, status), the order, the page size,
 * the cursor links and their refusals. One Pro shop with 45 products (stock labels, money and odd titles among them) is shared
 * by the tests of this file; they only read it.
 */

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

test('[inventory.list.page-size-20, inventory.list.order-newest-first, inventory.list.row-name, inventory.list.row-stock-number, inventory.paging.next-page, inventory.paging.first-page, inventory.paging.last-page-no-next] 45 products come as 20, 20 and 5, newest first, equal to the database', async ({ page }) => {
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

test('[inventory.list.row-name] a title with markup is shown as text and a long title wraps without sideways scroll', async ({ page }) => {
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

test('[inventory.list.row-price, inventory.list.row-status-label, inventory.list.stock-boundaries] money follows the row currency and labels follow the thresholds', async ({ page }) => {
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

test('[inventory.list.only-own-shop] the list holds only this shop\'s ACTIVE products', async ({ page }) => {
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

test('[inventory.paging.next-page] "Next page" is a link that keeps the stock filter in the address', async ({ page }) => {
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

test('[inventory.paging.invalid-cursor, inventory.paging.cursor-other-filter] an unknown cursor or one from another filter shows the refusal with a way back', async ({ page }) => {
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
