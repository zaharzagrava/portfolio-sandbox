import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openShop, register, seedProduct, shopPath } from '../helpers';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';

/**
 * VA rows of W04 (AS-28, AS-31, AS-32, AS-97): the inventory at the phone (390 x 844) and desktop (1280 x 800) widths (the
 * `mobile` and `desktop` projects run every test), with axe on every state. The member and the shop are real; the list is
 * made of products created through the API, the error state of a cursor the API refuses, the loading state of the page's
 * own RSC request held back. Baselines are committed when the final run produces them.
 */

const stylePath = path.join(__dirname, 'hide-dev-overlay.css');
const content = (page: Page) => page.locator('#main-content');
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;

/** Axe on the page and nothing wider than the viewport at 320 px (the phone frame must not scroll sideways). */
async function expectAccessibleAndContained(page: Page) {
  await expectNoSeriousViolations(page);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  await expectMainFitsWidth(page);
  if (original) await page.setViewportSize(original);
}

async function memberWithShop(page: Page) {
  const member = await register(page);
  const shop = await openShop(page);
  return { ...member, ...shop };
}

test.describe('Seller inventory layout', () => {
  test('W04 AS-28 AS-97 VA list: table on desktop, cards on the phone', async ({ page }) => {
    const { shopId, shopName, email } = await memberWithShop(page);
    await seedProduct(shopId, { title: 'Seeded Walnut Spoon', quantity: 4, priceMinor: 1200 }, { email });
    await seedProduct(shopId, { title: 'Seeded Linen Apron With A Very Long Name That Has To Wrap Inside Its Cell Without Widening The Page', quantity: 0 }, { email });
    await seedProduct(shopId, { title: 'Seeded Oak Board', quantity: 40, priceMinor: 8900 }, { email });
    await page.goto(shopPath(shopId, 'inventory'));
    await expect(page.getByRole('table', { name: `Products of ${shopName}` })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Seeded Oak Board' })).toContainText('In stock');
    if (isPhone(page)) {
      await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible();
    } else {
      await expect(page.getByRole('tablist', { name: 'Product status' })).toBeVisible();
    }
    await expect(content(page)).toHaveScreenshot('list.png', { stylePath });
    await expectAccessibleAndContained(page);
  });

  test('W04 AS-31 VA loading: the frame is on screen, the content is a skeleton', async ({ page }) => {
    const { shopId } = await memberWithShop(page);
    await page.goto(shopPath(shopId));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(new RegExp(`/dashboard/seller/${shopId}/inventory\\?_rsc=`), async (route) => {
      await held;
      await route.continue();
    });
    if (isPhone(page)) await page.getByRole('button', { name: 'Open menu' }).click();
    const nav = (isPhone(page) ? page.getByRole('dialog') : page.locator('aside')).getByRole('navigation', { name: 'Seller' });
    await nav.getByRole('link', { name: 'Inventory' }).click();
    await expect(page.locator('[data-skeleton]').first()).toBeVisible();
    await expect(content(page)).toHaveScreenshot('loading.png', { stylePath });
    release();
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
  });

  test('W04 AS-31 VA error: a refused page link shows the problem with a way back', async ({ page }) => {
    const { shopId } = await memberWithShop(page);
    await page.goto(`${shopPath(shopId, 'inventory')}?cursor=bogus`);
    const alert = page.getByRole('alert').filter({ hasText: 'That page link is no longer valid.' });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('link', { name: 'Go to the first page' })).toBeVisible();
    await expect(content(page)).toHaveScreenshot('error.png', { stylePath });
    await expectAccessibleAndContained(page);
  });

  test('W04 AS-32 VA empty states: no products, no match, no archived products', async ({ page }) => {
    const { shopId } = await memberWithShop(page);
    await page.goto(shopPath(shopId, 'inventory'));
    await expect(page.getByText('No products yet.')).toBeVisible();
    await expect(content(page)).toHaveScreenshot('empty-none.png', { stylePath });
    await expectAccessibleAndContained(page);

    await page.goto(`${shopPath(shopId, 'inventory')}?q=zzzzqq`);
    await expect(page.getByText('No products match “zzzzqq”.')).toBeVisible();
    await expect(content(page)).toHaveScreenshot('empty-search.png', { stylePath });
    await expectAccessibleAndContained(page);

    await page.goto(`${shopPath(shopId, 'inventory')}?status=ARCHIVED`);
    await expect(page.getByText('No archived products.')).toBeVisible();
    await expect(content(page)).toHaveScreenshot('empty-archived.png', { stylePath });
    await expectAccessibleAndContained(page);
  });
});
