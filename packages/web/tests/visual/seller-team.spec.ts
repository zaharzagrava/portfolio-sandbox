import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openShop, register, shopPath } from '../helpers';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';

/**
 * VA rows of W04 (AS-74, AS-83, AS-97): the members list and the shop orders at the phone (390 x 844) and desktop
 * (1280 x 800) widths, with axe on each. The member and the shop are real; the orders are stubbed in the browser so the
 * list has rows (a fresh shop has none). Baselines are committed when the final run produces them.
 */

const stylePath = path.join(__dirname, 'hide-dev-overlay.css');
const content = (page: Page) => page.locator('#main-content');

async function expectAccessibleAndContained(page: Page) {
  await expectNoSeriousViolations(page);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  await expectMainFitsWidth(page);
  if (original) await page.setViewportSize(original);
}

const slice = (n: number, status: string) => ({
  shopOrderId: `abcdef0${n}-0000-4000-8000-00000000000${n}`,
  orderId: `1111111${n}-0000-4000-8000-00000000000${n}`,
  status,
  subtotalMinor: 2450 * n,
  currency: 'EUR',
  createdAt: `2026-10-1${n}T09:30:00.000Z`,
  items: Array.from({ length: n }, (_, index) => ({ productId: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b', shopId: null, title: `Mug ${index}`, quantity: 1, unitPriceMinor: 2450, discountMinor: 0, lineTotalMinor: 2450 })),
});

test.describe('Seller team layout', () => {
  test('W04 AS-74 AS-97 VA members: table on desktop, cards on the phone', async ({ page }) => {
    await register(page);
    const { shopId, shopName } = await openShop(page);
    await page.goto(shopPath(shopId, 'team'));
    await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
    await expect(page.getByRole('table', { name: `Members of ${shopName}` })).toBeVisible();
    await expect(page.getByText('(you)')).toBeVisible();
    await expect(content(page)).toHaveScreenshot('team-members.png', { stylePath });
    await expectAccessibleAndContained(page);
  });

  test('W04 AS-79 AS-97 VA roles: the matrix reads without colour', async ({ page }) => {
    await register(page);
    const { shopId } = await openShop(page);
    await page.goto(shopPath(shopId, 'team?tab=roles'));
    await expect(page.getByRole('table', { name: 'Roles and permissions' })).toBeVisible();
    await expect(page.getByText('Not allowed').first()).toBeVisible();
    await expect(content(page)).toHaveScreenshot('team-roles.png', { stylePath });
    await expectAccessibleAndContained(page);
  });
});

test.describe('Seller orders layout', () => {
  test('W04 AS-83 AS-97 VA orders: table on desktop, cards on the phone, no buyer', async ({ page }) => {
    await register(page);
    const { shopId } = await openShop(page);
    await page.route('**/api/shops/*/orders*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [slice(3, 'PAID'), slice(2, 'PENDING'), slice(1, 'REFUNDED')], nextCursor: 'next' }) }),
    );
    await page.goto(shopPath(shopId, 'orders'));
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: '00000003' })).toContainText('Paid');
    await expect(page.getByText('buyer-3')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Next page' })).toBeVisible();
    await expect(content(page)).toHaveScreenshot('orders.png', { stylePath });
    await expectAccessibleAndContained(page);
  });
});
