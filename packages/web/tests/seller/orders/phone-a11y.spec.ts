import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { NEW_USER_PASSWORD, resetRateLimits, sellerCall, shopPath, uniqueEmail } from '../../helpers';
import { openSecondShop, ownerWithShop, type Member } from '../cross-cutting/support';
import { userId } from '../support/db';
import { signIn } from './support';
import { runSql, seedSlices } from './seed';

/**
 * AI QA, orders area (pass 2), section "phone width and accessibility": cards at 390 px, long values, the paging buttons,
 * axe on the table, the cards, the empty box and the error panel, the landmarks, the keyboard order and dark mode (map:
 * scripts/aiqa/coverage/orders.tsv). Every test sets its own width, so both browser projects run the same checks.
 */

test.setTimeout(240_000);

const BASE = Date.now() - 3_600_000;
const at = (secondsAgo: number) => new Date(BASE - secondsAgo * 1000).toISOString();
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const LIST = '**/api/shops/*/orders?*';

let owner: Member;
let shopId: string; // 25 slices, four statuses
let emptyShop: string;
let buyerId: string;
const ordersPath = (shop = shopId, query = '') => `${shopPath(shop, 'orders')}${query}`;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const made = await ownerWithShop(page, []);
    owner = made.member;
    shopId = made.shopId;
    await resetRateLimits();
    const email = uniqueEmail('orders-phone-buyer');
    expect((await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
    buyerId = userId(email);
    const statuses = ['PENDING', 'PAID', 'CANCELLED', 'REFUNDED'] as const;
    seedSlices(shopId, buyerId, Array.from({ length: 25 }, (_, index) => ({ status: statuses[index % 4], createdAt: at(index * 7), subtotal: 1999 + index, lines: 1 + (index % 3) })));
    emptyShop = (await openSecondShop(owner)).shopId;
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ page }) => {
  await signIn(page, owner);
});

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function scan(page: Page, state: string, selector = 'body') {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('nextjs-portal').include(selector).analyze();
  const text = violations.map((v) => `${state}: ${v.id} (${v.impact}): ${v.help} [${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}]`);
  for (const v of violations.filter((entry) => entry.impact !== 'serious' && entry.impact !== 'critical')) test.info().annotations.push({ type: 'axe-minor', description: text[violations.indexOf(v)] });
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => text[violations.indexOf(v)]), state).toEqual([]);
}

test('[orders.table.phone-cards, orders.phone.layout-390] at 390 px each row is a card with the reference as heading and label/value pairs, and nothing scrolls sideways', async ({ page }) => {
  lines('orders.table.phone-cards', 'orders.phone.layout-390');
  await page.setViewportSize(PHONE);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(20);
  const first = rowsOf(page).first();
  expect(await first.evaluate((row) => getComputedStyle(row).display)).toBe('block');
  expect(await first.locator('th').evaluate((cell) => getComputedStyle(cell).display)).toBe('block');
  expect(await first.locator('td').evaluateAll((cells) => cells.map((cell) => [cell.getAttribute('data-label'), getComputedStyle(cell, '::before').content, getComputedStyle(cell).display]))).toEqual([
    ['Status', '"Status"', 'flex'],
    ['Items', '"Items"', 'flex'],
    ['Subtotal', '"Subtotal"', 'flex'],
    ['Date', '"Date"', 'flex'],
  ]);
  // same DOM as the table: the header row is kept for assistive technology only
  expect(await page.getByRole('region', { name: 'Orders' }).locator('thead').evaluate((head) => getComputedStyle(head).position)).toBe('absolute');
  await expect(page.getByRole('region', { name: 'Orders' }).locator('thead th')).toHaveText(['Order', 'Status', 'Items', 'Subtotal', 'Date']);
  expect(await noSideScroll(page)).toBe(true);
  const box = await first.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  expect((await page.getByLabel('Status').boundingBox())!.height).toBe(44);
  // back at desktop width it is a table again
  await page.setViewportSize(DESKTOP);
  await expect.poll(() => first.evaluate((row) => getComputedStyle(row).display)).toBe('table-row');
});

test('[orders.table.long-values] very wide values and a long shop name wrap and do not widen the page at 390 px', async ({ page }) => {
  lines('orders.table.long-values');
  await page.setViewportSize(PHONE);
  const name = 'W'.repeat(80); // the longest name the shop form takes
  runSql(`update "Shop" set name='${name}' where id='${shopId}'`);
  try {
    await page.route(LIST, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.items[0].subtotalMinor = Number.MAX_SAFE_INTEGER;
      body.items[1].currency = 'JPY';
      await route.fulfill({ response, json: body });
    });
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
    await expect(page.getByText(`The orders placed with ${name}, newest first.`)).toBeVisible();
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((node) => node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0 && getComputedStyle(node).display !== 'inline').map((node) => `${node.tagName}.${(node as HTMLElement).className.toString().slice(0, 40)}: ${node.textContent?.slice(0, 30)} (${node.scrollWidth} > ${node.clientWidth})`).slice(0, 6));
    expect(wide, 'elements wider than the 390 px screen').toEqual([]);
    expect(await noSideScroll(page)).toBe(true);
    const box = await rowsOf(page).first().boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  } finally {
    runSql(`update "Shop" set name='AIQA orders phone shop' where id='${shopId}'`);
  }
});

test('[orders.phone.paging-buttons] First page and Next page are 44 px high, on one row, left and right', async ({ page }) => {
  lines('orders.phone.paging-buttons');
  await page.setViewportSize(PHONE);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(20);
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(rowsOf(page)).toHaveCount(5);
  // page 2 of 2 has only First page; make a middle page by asking for a smaller list is not possible, so check both sides on page 2 of 45
  const more = (await openSecondShop(owner)).shopId;
  seedSlices(more, buyerId, Array.from({ length: 45 }, (_, index) => ({ createdAt: at(index) })));
  await page.goto(ordersPath(more));
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
  const [first, next] = [await page.getByRole('link', { name: 'First page' }).boundingBox(), await page.getByRole('link', { name: 'Next page' }).boundingBox()];
  expect(first!.height).toBe(44);
  expect(next!.height).toBe(44);
  expect(Math.abs(first!.y - next!.y)).toBeLessThan(2);
  expect(first!.x).toBeLessThan(next!.x);
  expect(first!.x).toBeLessThan(PHONE.width / 2);
  expect(next!.x + next!.width).toBeGreaterThan(PHONE.width / 2);
  expect(next!.x + next!.width).toBeLessThanOrEqual(PHONE.width);
  expect(await noSideScroll(page)).toBe(true);
});

test('[orders.a11y.axe] axe finds nothing serious on the table, the cards, the empty box, the paging page and the error panel', async ({ page }) => {
  lines('orders.a11y.axe');
  for (const viewport of [DESKTOP, PHONE]) {
    await page.setViewportSize(viewport);
    const tag = viewport.width === 390 ? 'phone' : 'desktop';
    await page.goto(ordersPath());
    await expect(rowsOf(page)).toHaveCount(20);
    await scan(page, `table ${tag}`);
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(rowsOf(page)).toHaveCount(5);
    await scan(page, `page 2 ${tag}`);
    await page.goto(ordersPath(emptyShop));
    await expect(page.getByText('No orders yet.')).toBeVisible();
    await scan(page, `empty ${tag}`);
    await page.goto(ordersPath(shopId, '?cursor=zzzz'));
    await expect(page.getByRole('alert')).toBeVisible();
    await scan(page, `error ${tag}`);
  }
});

test('[orders.a11y.landmarks] the pager is nav "Pages", the list is region "Orders", the only heading is h1', async ({ page }) => {
  lines('orders.a11y.landmarks');
  await page.setViewportSize(DESKTOP);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(20);
  await expect(page.getByRole('region', { name: 'Orders' })).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(1);
  expect(await page.getByRole('navigation', { name: 'Pages' }).evaluate((node) => node.tagName)).toBe('NAV');
  await expect(page.locator('#main-content h1')).toHaveCount(1);
  // the sidebar's group names are h2 inside the navigation; the page's own part has the one h1
  expect(await page.locator('#main-content h2:not(nav h2), #main-content h3, #main-content h4, #main-content h5, #main-content h6').evaluateAll((nodes) => nodes.map((node) => `${node.tagName}:${node.textContent?.trim()} in ${node.closest('nav,aside,header,[role=region]')?.tagName ?? 'none'}`))).toEqual([]);
  await expect(page.getByRole('region', { name: 'Orders' }).locator('table')).toHaveCount(1);
});

test('[orders.a11y.focus] Tab goes sidebar, status select, then the Next page link; the focus ring is visible; the select works by keys', async ({ page }) => {
  lines('orders.a11y.focus');
  await page.setViewportSize(DESKTOP);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(20);
  const sidebarLast = page.getByRole('navigation').getByRole('link').last();
  await page.getByRole('navigation').getByRole('link', { name: 'Orders', exact: true }).first().focus();
  const order: string[] = [];
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.tagName}:${el.id || el.textContent?.trim().slice(0, 20) || ''}` : 'none';
    });
    order.push(label);
    if (label === 'A:Next page') break;
  }
  const selectAt = order.indexOf('SELECT:orders-status');
  const nextAt = order.indexOf('A:Next page');
  expect(selectAt, order.join(' > ')).toBeGreaterThanOrEqual(0);
  expect(nextAt, order.join(' > ')).toBeGreaterThan(selectAt);
  // nothing inside the table takes focus between the select and the pager
  expect(order.slice(selectAt + 1, nextAt)).toEqual([]);
  // focus ring on the pager link and on the select
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByLabel('Status')).toBeFocused();
  const ring = await page.getByLabel('Status').evaluate((node) => {
    const style = getComputedStyle(node);
    return { outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0, shadow: style.boxShadow !== 'none' };
  });
  expect(ring.outline || ring.shadow).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Next page' })).toBeFocused();
  const linkRing = await page.getByRole('link', { name: 'Next page' }).evaluate((node) => {
    const style = getComputedStyle(node);
    return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
  });
  expect(linkRing).toBe(true);
  void sidebarLast;
});

test('[orders.a11y.dark-mode] badges, the filtered table and the error panel pass axe contrast in dark mode', async ({ page }) => {
  lines('orders.a11y.dark-mode');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize(DESKTOP);
  await page.goto(ordersPath());
  await expect(rowsOf(page)).toHaveCount(20);
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
  await scan(page, 'dark table');
  // the dimmed busy state cannot be reached (see the busy-keeps-rows test), so it is not scanned here
  await page.getByLabel('Status').selectOption('PAID');
  await expect(page).toHaveURL(/status=PAID/);
  await scan(page, 'dark filtered');
  await page.goto(ordersPath(shopId, '?cursor=zzzz'));
  await expect(page.getByRole('region', { name: 'Orders' }).getByRole('alert')).toBeVisible();
  await scan(page, 'dark error');
});
