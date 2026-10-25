import { expect, test, type Page } from '@playwright/test';
import { NEW_USER_PASSWORD, resetRateLimits, sellerCall, shopPath, uniqueEmail } from '../../helpers';
import { ownerWithShop, type Member } from '../cross-cutting/support';
import { userId } from '../support/db';
import { signIn } from './support';
import { seedSlices } from './seed';

/**
 * AI QA, orders area (pass 2): the shape of the list answer, what the OWNER sees, and the way out of a refused status in the
 * address (map: scripts/aiqa/coverage/orders.tsv).
 */

test.setTimeout(180_000);

const BASE = Date.now() - 3_600_000;
const at = (secondsAgo: number) => new Date(BASE - secondsAgo * 1000).toISOString();
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');

let owner: Member;
let token: string;
let shopId: string;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const made = await ownerWithShop(page, []);
    ({ member: owner, token, shopId } = made);
    await resetRateLimits();
    const email = uniqueEmail('orders-contract-buyer');
    expect((await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
    seedSlices(shopId, userId(email), [0, 1, 2, 3, 4, 5].map((index) => ({ status: (['PENDING', 'PAID', 'CANCELLED'] as const)[index % 3], createdAt: at(index * 9), subtotal: 1000 + index, lines: 1 + (index % 2) })));
  } finally {
    await context.close();
  }
});

test('[orders.api.contract] the list answer has exactly the fields of the contract: no extra and no missing', async () => {
  lines('orders.api.contract');
  const answer = await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, token);
  expect(answer.status).toBe(200);
  expect(Object.keys(answer.data).sort()).toEqual(['items', 'nextCursor']);
  expect(answer.data.nextCursor).toBeNull();
  expect(answer.data.items).toHaveLength(6);
  for (const item of answer.data.items) {
    expect(Object.keys(item).sort()).toEqual(['createdAt', 'currency', 'items', 'orderId', 'shopOrderId', 'status', 'subtotalMinor']);
    expect(item.createdAt).toBe(new Date(item.createdAt).toISOString());
    expect(['PENDING', 'PAID', 'CANCELLED', 'REFUNDED']).toContain(item.status);
    expect(Number.isInteger(item.subtotalMinor)).toBe(true);
    expect(item.currency).toMatch(/^[A-Z]{3}$/);
    expect(item.items.length).toBeGreaterThan(0);
    for (const line of item.items) {
      expect(Object.keys(line).sort()).toEqual(['discountMinor', 'lineTotalMinor', 'productId', 'quantity', 'shopId', 'title', 'unitPriceMinor']);
    }
  }
});

test('[orders.role.owner] the OWNER sees the page and every slice of the shop', async ({ page }) => {
  lines('orders.role.owner');
  await signIn(page, owner);
  await page.goto(shopPath(shopId, 'orders'));
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  await expect(rowsOf(page)).toHaveCount(6);
  const api = (await sellerCall('GET', `/api/shops/${shopId}/orders`, undefined, token)).data.items as { shopOrderId: string }[];
  expect(await rowsOf(page).locator('th').allInnerTexts()).toEqual(api.map((item) => item.shopOrderId.slice(-8)));
  await expect(page.getByRole('region', { name: 'Orders' }).getByRole('button')).toHaveCount(0);
});

test('[orders.filter.invalid-value-select-blank] ?status=BOGUS: the select and the panel, and the way out', async ({ page }) => {
  lines('orders.filter.invalid-value-select-blank');
  await signIn(page, owner);
  await page.goto(`${shopPath(shopId, 'orders')}?status=BOGUS`);
  const panel = page.getByRole('region', { name: 'Orders' }).getByRole('alert');
  await expect(panel).toContainText('Check this field.');
  // the map expected a blank select; record what it shows, and that picking an option leaves the error
  const shown = await page.getByLabel('Status').evaluate((select: HTMLSelectElement) => select.selectedOptions[0]?.textContent ?? '(none)');
  test.info().annotations.push({ type: 'observed', description: `select shows "${shown}", value "${await page.getByLabel('Status').inputValue()}"` });
  await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
  // W04.R-10: an unsupported value becomes its default: the page must not stay on an error with a select that already says "All statuses"
  await expect(rowsOf(page).or(page.getByRole('link', { name: /all statuses|clear filter|first page/i }))).not.toHaveCount(0);
  await page.getByLabel('Status').selectOption('PENDING');
  await expect(rowsOf(page)).toHaveCount(2);
});
