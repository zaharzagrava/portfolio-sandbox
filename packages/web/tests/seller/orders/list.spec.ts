import { expect, test, type Page } from '@playwright/test';
import { shopPath } from '../../helpers';
import { watchApi } from '../cross-cutting/support';
import { readSlices, shopWithOrders, signIn, type Fixture, type Slice } from './support';

/**
 * AI QA, orders area, section "filter and table" (map: scripts/aiqa/coverage/orders.tsv). One test covers several map lines;
 * the lines are in the title and in the `aiqa-lines` annotation so the results can be copied into the map.
 * The shop has 21 slices: 15 pending, 3 paid (really paid), 1 cancelled, 1 of two lines, 1 from an order across two shops.
 * Nothing in the stack can make a REFUNDED slice, so that status is only checked for its empty state.
 */

test.setTimeout(240_000);

let fx: Fixture;
let slices: Slice[];

test.beforeAll(async ({ browser }) => {
  fx = await shopWithOrders(browser, { pending: 15, paid: 3 });
  slices = await readSlices(fx.token, fx.shopId);
  expect(slices).toHaveLength(21);
});

const ordersPath = (query = '') => `${shopPath(fx.shopId, 'orders')}${query}`;
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const money = (minor: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 10 ** (new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2));
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');

test.beforeEach(async ({ page }) => {
  await signIn(page, fx.owner);
});

/** Answers the orders list with `change` applied to the real answer (the server still sends the real data). */
async function mutateAnswer(page: Page, change: (body: { items: Slice[] }) => void) {
  await page.route('**/api/shops/*/orders?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    change(body);
    await route.fulfill({ response, json: body });
  });
}

test.describe('filter', () => {
  test('[orders.filter.label, orders.filter.select-options, orders.filter.keyboard] the status select has a label, the four options and works by keyboard', async ({ page }) => {
    lines('orders.filter.label', 'orders.filter.select-options', 'orders.filter.keyboard');
    await page.goto(ordersPath());
    const select = page.getByLabel('Status');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText(['All statuses', 'Pending', 'Paid', 'Cancelled', 'Refunded']);
    await page.locator('label[for="orders-status"]').click();
    await expect(select).toBeFocused();
    await select.press('ArrowDown');
    await expect(page).toHaveURL(/\?status=PENDING$/);
    await select.press('ArrowUp');
    await expect(page).toHaveURL(ordersPath());
    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(/\?status=PENDING$/);
    await expect(select).toBeFocused();
    await expect(select).toHaveValue('PENDING');
    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(/\?status=PAID$/);
    await expect(select).toBeFocused();
  });

  test('[orders.filter.choose-status, orders.filter.status-pending, orders.filter.status-cancelled, orders.filter.back-to-all] each status asks the API for it and shows only that status', async ({ page }) => {
    lines('orders.filter.choose-status', 'orders.filter.status-pending', 'orders.filter.status-cancelled', 'orders.filter.back-to-all');
    const api = watchApi(page);
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
    for (const [status, label] of [['PAID', 'Paid'], ['PENDING', 'Pending'], ['CANCELLED', 'Cancelled']] as const) {
      const asked = page.waitForRequest((request) => /\/api\/shops\/[^/]+\/orders\?/.test(request.url()) && request.url().includes(`limit=20&status=${status}`));
      await page.getByLabel('Status').selectOption(status);
      await asked;
      await expect(page).toHaveURL(new RegExp(`\\?status=${status}$`));
      const expected = slices.filter((slice) => slice.status === status);
      await expect(rowsOf(page)).toHaveCount(Math.min(expected.length, 20));
      await expect(rowsOf(page).locator('td:nth-of-type(1)')).toHaveText(Array(Math.min(expected.length, 20)).fill(label));
      // the list was asked for with this status (the answer is 200) and nothing else was refused
      expect(api.seen.filter((entry) => entry.path.endsWith('/orders') && entry.status !== null && entry.status !== 200)).toEqual([]);
      expect(api.seen.some((entry) => entry.path.endsWith('/orders'))).toBe(true);
    }
    await page.getByLabel('Status').selectOption('');
    await expect(page).toHaveURL(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
  });

  test('[orders.filter.status-refunded] a status with no slices shows the empty message and a way back', async ({ page }) => {
    lines('orders.filter.status-refunded');
    // No stack route makes a REFUNDED slice, so only the empty state of the filter can be proved here.
    await page.goto(ordersPath('?status=REFUNDED'));
    await expect(page.getByText('No orders match this status.')).toBeVisible();
    await page.getByRole('link', { name: 'Clear filter' }).click();
    await expect(page).toHaveURL(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
  });

  test('[orders.filter.drops-cursor, orders.filter.address-restore] the status leaves the cursor, and the address brings the filter back', async ({ page }) => {
    lines('orders.filter.drops-cursor', 'orders.filter.address-restore');
    await page.goto(ordersPath());
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/cursor=/);
    await expect(rowsOf(page)).toHaveCount(1);
    await page.getByLabel('Status').selectOption('PAID');
    await expect(page).toHaveURL(ordersPath('?status=PAID'));
    await expect(rowsOf(page)).toHaveCount(3);
    await page.reload();
    await expect(page.getByLabel('Status')).toHaveValue('PAID');
    await expect(rowsOf(page)).toHaveCount(3);
    await page.goto(ordersPath());
    await page.goBack();
    await expect(page.getByLabel('Status')).toHaveValue('PAID');
  });

  test('[orders.filter.select-size-phone] the select is 44 px high on a phone and 32 px on a desktop', async ({ page }) => {
    lines('orders.filter.select-size-phone');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ordersPath());
    expect((await page.getByLabel('Status').boundingBox())?.height).toBe(44);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await page.getByLabel('Status').boundingBox())?.height).toBe(32);
  });

  test('[orders.filter.unknown-status-in-address] a lower-case or broken status is the default, an upper-case unknown one is refused by the API', async ({ page }) => {
    lines('orders.filter.unknown-status-in-address');
    const api = watchApi(page);
    for (const value of ['bogus', '%25%25']) {
      await page.goto(ordersPath(`?status=${value}`));
      await expect(rowsOf(page)).toHaveCount(20);
      await expect(page.getByLabel('Status')).toHaveValue('');
    }
    api.reset();
    await page.goto(ordersPath('?status=BOGUS'));
    await expect.poll(() => api.matching('GET', /\/orders$/).map((entry) => entry.status)).toContain(400);
  });

  test('[orders.filter.bad-upper-status-ui] an unknown status in the address leaves the person a way out (W04.R-10: it becomes the default)', async ({ page }) => {
    lines('orders.filter.bad-upper-status-ui');
    await page.goto(ordersPath('?status=BOGUS'));
    // W04.R-10: an unsupported value MUST become its default. At least the person must see orders or an action that clears it.
    await expect(rowsOf(page).or(page.getByRole('link', { name: /all statuses|clear filter|first page/i }))).not.toHaveCount(0);
  });

  test('[orders.filter.repeated-status] a repeated status in the address is the default on screen and in the first read (W04.R-10)', async ({ page }) => {
    lines('orders.filter.repeated-status');
    await page.goto(ordersPath('?status=PAID&status=PENDING'));
    await expect(rowsOf(page)).toHaveCount(20);
    await expect(page.getByLabel('Status')).toHaveValue('');
  });
});

test.describe('table', () => {
  test('[orders.table.region, orders.table.header-cells, orders.table.reference, orders.table.status-badge, orders.table.items-count, orders.table.subtotal, orders.table.date] a row shows what the API sent for it', async ({ page }) => {
    lines('orders.table.region', 'orders.table.header-cells', 'orders.table.reference', 'orders.table.status-badge', 'orders.table.items-count', 'orders.table.subtotal', 'orders.table.date');
    await page.goto(ordersPath());
    const region = page.getByRole('region', { name: 'Orders' });
    await expect(region.locator('caption')).toHaveText(`Orders of ${fx.shopName}`);
    await expect(region.locator('thead th')).toHaveText(['Order', 'Status', 'Items', 'Subtotal', 'Date']);
    expect(await region.locator('thead th').evaluateAll((cells) => cells.map((cell) => cell.getAttribute('scope')))).toEqual(Array(5).fill('col'));
    await expect(region.locator('tbody tr').first().locator('th')).toHaveAttribute('scope', 'row');
    await expect(rowsOf(page)).toHaveCount(20);
    for (const [index, slice] of slices.slice(0, 20).entries()) {
      const row = rowsOf(page).nth(index);
      await expect(row.locator('th')).toHaveText(slice.shopOrderId.slice(0, 8));
      await expect(row.locator('th span')).toHaveClass(/font-mono/);
      await expect(row.locator('td').nth(0)).toHaveText(slice.status[0] + slice.status.slice(1).toLowerCase());
      await expect(row.locator('td').nth(1)).toHaveText(String(slice.items.length));
      await expect(row.locator('td').nth(2)).toHaveText(money(slice.subtotalMinor, slice.currency));
      const time = row.locator('time');
      await expect(time).toHaveAttribute('datetime', new Date(slice.createdAt).toISOString());
      await expect(time).toHaveAttribute('title', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
      await expect(time).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M$/);
    }
    // the newest slice is first
    expect(slices.map((slice) => slice.createdAt)).toEqual([...slices.map((slice) => slice.createdAt)].sort().reverse());
  });

  test('[orders.table.reference-collision] two slices have two different references on screen (W04.B-32)', async ({ page }) => {
    lines('orders.table.reference-collision');
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
    const references = await rowsOf(page).locator('th').allInnerTexts();
    // The reference is the first 8 characters of a time-ordered id: slices made in the same minute read the same.
    expect(new Set(references).size, `references: ${references.join(' ')}`).toBe(references.length);
  });

  test('[orders.table.items-count, orders.table.items-only-this-shop, orders.table.subtotal-vs-lines] lines count rows not units; another shop\'s lines and money never appear', async () => {
    lines('orders.table.items-count', 'orders.table.items-only-this-shop', 'orders.table.subtotal-vs-lines');
    const quantityThree = slices.find((slice) => slice.items.length === 1 && slice.items[0].quantity === 3);
    expect(quantityThree, 'a one-line slice of quantity 3 exists').toBeTruthy();
    const multi = slices.find((slice) => slice.orderId === fx.orders.multiLine);
    expect(multi?.items.map((item) => item.quantity).sort()).toEqual([2, 3]);
    const mixed = slices.find((slice) => slice.orderId === fx.orders.mixed);
    expect(mixed?.items.map((item) => [item.shopId, item.quantity])).toEqual([[fx.shopId, 2]]);
    expect(mixed?.subtotalMinor).toBe(500);
    expect(JSON.stringify(slices)).not.toContain(fx.otherShopId);
    for (const slice of slices) expect(slice.items.reduce((sum, item) => sum + item.lineTotalMinor, 0), slice.shopOrderId).toBe(slice.subtotalMinor);
    // the other shop sees only its own part of the same order
    const otherSlices = await readSlices(fx.token, fx.otherShopId);
    expect(otherSlices.map((slice) => [slice.orderId, slice.subtotalMinor])).toEqual([[fx.orders.mixed, 3108]]);
  });

  test('[orders.table.currency-zero-decimal, orders.table.no-default-currency] each row is formatted with its own currency and its digits', async ({ page }) => {
    lines('orders.table.currency-zero-decimal', 'orders.table.no-default-currency');
    await mutateAnswer(page, (body) => {
      body.items[0].currency = 'JPY';
      body.items[1].currency = 'KWD';
      body.items[2].currency = 'usd';
    });
    await page.goto(ordersPath());

    await expect(rowsOf(page).nth(0).locator('td').nth(2)).toHaveText(/^¥/);
    await expect(rowsOf(page).nth(1).locator('td').nth(2)).toHaveText(/^KWD\s\d+\.\d{3}$/);
    await expect(rowsOf(page).nth(2).locator('td').nth(2)).toHaveText(/^\$/);
    await expect(rowsOf(page).nth(3).locator('td').nth(2)).toHaveText(/^€/);
  });

  test('[orders.table.currency-unknown-code] a row with a currency the browser does not know does not take the whole page down', async ({ page }) => {
    lines('orders.table.currency-unknown-code');
    await mutateAnswer(page, (body) => {
      body.items[0].currency = 'XX1';
    });
    const answered = page.waitForResponse((response) => /\/api\/shops\/[^/]+\/orders\?/.test(response.url()));
    await page.goto(ordersPath());
    await answered; // the browser's own read, with the bad currency in the first row
    await expect(rowsOf(page).nth(1)).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('[orders.table.big-number] the largest safe amount is shown to the cent', async ({ page }) => {
    lines('orders.table.big-number');
    // The server refuses amounts above 2^53 - 1 (500 for the whole list, by design); the largest safe one must be exact.
    await mutateAnswer(page, (body) => {
      body.items[0].subtotalMinor = Number.MAX_SAFE_INTEGER;
    });
    await page.goto(ordersPath());
    await expect(rowsOf(page).nth(0).locator('td').nth(2)).toHaveText('€90,071,992,547,409.91');
  });

  test('[orders.table.status-unknown] a status outside the four is not a title-case badge but the page error (strict answer check)', async ({ page }) => {
    lines('orders.table.status-unknown');
    await mutateAnswer(page, (body) => {
      (body.items[0] as { status: string }).status = 'PARTIALLY_SHIPPED';
    });
    await page.goto(ordersPath());
    await expect(page.getByText('Partially Shipped')).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: /went wrong|try again/i })).toBeVisible();
  });
});
