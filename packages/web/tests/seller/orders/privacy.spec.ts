import { expect, test, type Page } from '@playwright/test';
import { shopPath } from '../../helpers';
import { rows } from '../support/db';
import { readSlices, shopWithOrders, signIn, type Fixture, type Slice } from './support';

/**
 * AI QA, orders area (pass 2), section "privacy and read-only": what the page shows and what leaves the server about the buyer,
 * the line detail, links, markup in the shop name, and the export neighbour (map: scripts/aiqa/coverage/orders.tsv).
 */

test.setTimeout(240_000);

let fx: Fixture;
let slices: Slice[];

test.beforeAll(async ({ browser }) => {
  fx = await shopWithOrders(browser, { pending: 2, paid: 1 });
  slices = await readSlices(fx.token, fx.shopId);
});

const ordersPath = (query = '') => `${shopPath(fx.shopId, 'orders')}${query}`;
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');

test.beforeEach(async ({ page }) => {
  await signIn(page, fx.owner);
});

test('[orders.table.no-buyer-api-and-html] W04.B-32 / AS-83 (B-035): no buyer identifier in the list answer or in the page HTML', async ({ page }) => {
  lines('orders.table.no-buyer-api-and-html');
  const buyerId = rows(`select "userId" from "BisOrder" where id='${slices[0].orderId}'`)[0][0];
  expect(buyerId).toMatch(/^[0-9a-f-]{36}$/);
  const answer = await page.request.get(`/api/shops/${fx.shopId}/orders?limit=20`);
  expect(answer.status()).toBe(200);
  const text = await answer.text();
  expect(text, 'API answer carries the buyer id').not.toContain(buyerId);
  expect(text).not.toContain('buyerId');
  const html = await (await page.request.get(ordersPath())).text();
  expect(html, 'page HTML carries the buyer id').not.toContain(buyerId);
  expect(html).not.toContain('buyerId');
});

test('[orders.table.no-buyer-ui, orders.table.no-line-detail-ui, orders.table.row-not-link] nothing about the buyer or the lines is drawn; rows are plain text', async ({ page }) => {
  lines('orders.table.no-buyer-ui', 'orders.table.no-line-detail-ui', 'orders.table.row-not-link');
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(slices.length);
  const buyerId = rows(`select "userId" from "BisOrder" where id='${slices[0].orderId}'`)[0][0];
  const buyerEmail = fx.buyer.email;
  const region = page.getByRole('region', { name: 'Orders' });
  const visible = await page.locator('#main-content').innerText();
  const markup = await region.innerHTML();
  for (const secret of [buyerId, buyerEmail, buyerEmail.split('@')[0]]) {
    expect(visible, `visible text has ${secret}`).not.toContain(secret);
    expect(markup, `table markup has ${secret}`).not.toContain(secret);
  }
  // tooltips and accessible names: every title attribute is a time, no aria-label names a person
  const titles = await region.locator('[title]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title')));
  for (const title of titles) expect(title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  // no product title, quantity detail or unit price in the page
  for (const title of [fx.products.cheap, fx.products.mid]) expect(visible).not.toContain(title);
  expect(visible).not.toMatch(/Orders (Cheap|Mid|Other)/);
  // read-only: no link, button, menu or actions column inside the table; the row does nothing on click
  expect(await region.locator('table a, table button, table [role="menuitem"], table th:has-text("Actions")').count()).toBe(0);
  const before = page.url();
  await rowsOf(page).first().click();
  await rowsOf(page).first().locator('th').click();
  expect(page.url()).toBe(before);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('[orders.table.text-as-text, orders.security.xss-fields] a shop name with markup shows as text in the subtitle and the caption', async ({ page }) => {
  lines('orders.table.text-as-text', 'orders.security.xss-fields');
  const name = '<img src=x onerror=window.__pwned=1> <b>bold</b>';
  const original = fx.shopName;
  rows(`select 1`); // db reachable
  const { execFileSync } = await import('node:child_process');
  const run = (value: string) => execFileSync('docker', ['exec', '-i', process.env.AIQA_DB_CONTAINER ?? 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', `update "Shop" set name='${value.replace(/'/g, "''")}' where id='${fx.shopId}'`]);
  run(name);
  try {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(slices.length);
    await expect(page.getByText(`The orders placed with ${name}, newest first.`)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Orders' }).locator('caption')).toHaveText(`Orders of ${name}`);
    await expect(page.locator('#main-content img, #main-content b')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(dialogs).toEqual([]);
  } finally {
    run(original);
  }
});

test('[orders.neighbor.export-link] nothing on the orders page leads to the export page', async ({ page }) => {
  lines('orders.neighbor.export-link');
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(slices.length);
  // the page's own part: the heading block, the filter and the list (the sidebar's own "Order export" entry is a separate section)
  const own = page.locator('#main-content h1').locator('xpath=ancestor::div[contains(@class,"space-y-6")][1]');
  await expect(own).toHaveCount(1);
  const hrefs = await own.locator('a').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
  expect(hrefs.filter((href) => /export/i.test(href ?? ''))).toEqual([]);
  expect(await own.innerText()).not.toMatch(/export/i);
  // the sidebar entry exists and is the only way there
  const sidebar = await page.locator('nav a[href$="/exports"]').count();
  expect(sidebar).toBeGreaterThan(0);
});
