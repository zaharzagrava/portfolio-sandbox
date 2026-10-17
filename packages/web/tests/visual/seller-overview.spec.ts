import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openShop, register, shopPath } from '../helpers';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';

/**
 * VA rows of W04 (AS-10, AS-15, AS-17, AS-19, AS-96): the overview at the phone (390 x 844) and desktop (1280 x 800) widths
 * (the `mobile` and `desktop` projects run every test). The shop is the member's own, opened through the form. What the
 * server reads cannot be stubbed in the browser, so the sections with data come from the browser's own period request, which
 * is answered with the real response plus sales figures (the same shape the API sends). The live panel is masked: its numbers
 * and clock change every second. Baselines are committed when the final run produces them.
 */

const stylePath = path.join(__dirname, 'hide-dev-overlay.css');
const content = (page: Page) => page.locator('#main-content');
const OVERVIEW = '**/api/bff/seller/*/overview*';

const days = Array.from({ length: 7 }, (_, i) => {
  const day = `2026-10-${String(11 + i).padStart(2, '0')}`;
  return { day, revenueMinor: [0, 12000, 8000, 0, 30000, 15050, 45000][i]!, orders: [0, 2, 1, 0, 4, 2, 5][i]!, refundedMinor: i === 4 ? 2500 : 0 };
});

/** Reads the real overview answer and replaces its sales numbers; `fail` lists the sections to report as failed. */
async function answerWithSales(page: Page, fail: ('stats' | 'rank')[] = []) {
  await page.route(OVERVIEW, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const stats = {
      shopId: body.shop.id,
      days: 7,
      from: '2026-10-11',
      to: '2026-10-17',
      currency: 'EUR',
      summary: { revenueMinor: 110050, orders: 14, unitsSold: 22, uniqueBuyers: 11, refundsCount: 1, refundedMinor: 2500, netRevenueMinor: 107550, avgOrderValueMinor: 7861 },
      daily: days,
      topProducts: [
        { productId: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b', title: 'Handmade Ceramic Mug', revenueMinor: 60000, unitsSold: 15 },
        { productId: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6c', title: 'Linen Tea Towel', revenueMinor: 28050, unitsSold: 5 },
      ],
    };
    const rank = { period: { kind: 'week', id: '2026-W42', startsAt: '2026-10-12T00:00:00.000Z', endsAt: '2026-10-19T00:00:00.000Z', closed: false }, category: null, rank: 3, of: 120, topPercent: 3, revenueMinor: 110050 };
    await route.fulfill({
      response,
      json: {
        ...body,
        stats: fail.includes('stats') ? null : stats,
        rank: fail.includes('rank') ? null : rank,
        errors: fail.map((section) => ({ section, code: 'upstream_unavailable', retryable: true })),
      },
    });
  });
}

async function expectLayout(page: Page) {
  await expectNoSeriousViolations(page);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  await expectMainFitsWidth(page);
  if (original) await page.setViewportSize(original);
}

const shot = (page: Page, name: string) => expect(content(page)).toHaveScreenshot(name, { stylePath, mask: [page.getByRole('region', { name: 'Last 60 seconds' })] });

test.describe('Seller overview layout', () => {
  test('W04 AS-10 AS-96 VA overview with data', async ({ page }) => {
    await register(page);
    const { shopId } = await openShop(page);
    await answerWithSales(page);
    await page.goto(shopPath(shopId));
    await page.getByLabel('Period').selectOption('7');
    await expect(page.getByRole('region', { name: 'Top products' }).getByText(/Handmade Ceramic Mug/)).toBeVisible();
    await shot(page, 'overview-with-data.png');
    await expectLayout(page);
  });

  test('W04 AS-15 AS-96 VA overview of a new shop', async ({ page }) => {
    await register(page);
    const { shopId } = await openShop(page);
    await page.goto(shopPath(shopId));
    await expect(page.getByText('No orders yet today.')).toBeVisible();
    await expect(page.getByText(/Not ranked yet/)).toBeVisible();
    await shot(page, 'overview-new-shop.png');
    await expectLayout(page);
  });

  test('W04 AS-17 VA overview with a failed section', async ({ page }) => {
    await register(page);
    const { shopId } = await openShop(page);
    await answerWithSales(page, ['stats', 'rank']);
    await page.goto(shopPath(shopId));
    await page.getByLabel('Period').selectOption('7');
    await expect(page.getByRole('region', { name: 'Top products' }).getByText('Sales numbers are temporarily unavailable.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Leaderboard rank' }).getByText('Your rank is temporarily unavailable.')).toBeVisible();
    await shot(page, 'overview-partial.png');
    await expectLayout(page);
  });

  test('W04 AS-19 VA overview with the live panel connected', async ({ page }) => {
    await register(page);
    const { shopId } = await openShop(page);
    await page.goto(shopPath(shopId));
    const live = page.getByRole('region', { name: 'Last 60 seconds' });
    await expect(live.getByRole('status')).toHaveText(/Live|Connecting…/, { timeout: 15_000 });
    await expect(live).toBeVisible();
    await expect(live).toHaveScreenshot('overview-live-panel.png', { stylePath, mask: [live.locator('[data-live-values]')] });
    await expectLayout(page);
  });
});
