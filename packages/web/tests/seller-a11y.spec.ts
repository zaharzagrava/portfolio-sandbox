import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { closeMenu, openFiltersIfCollapsed, register, resetRateLimits, sellerMenu, shopPath } from './helpers';
import { PIXEL_PNG, archiveByApi, openSecondShop, ownerWithShop, shopWithSlug, uniqueTitle } from './seller/cross-cutting/support';

/**
 * W04 AS-113: an axe scan of every distinct state of the seller pages, ONE scan per state, desktop width. A serious or critical finding fails the test;
 * moderate and minor ones are written to the annotations (type `axe-minor`). Phone: only the two states whose layout differs (the drawer with the shop
 * switcher, the filters sheet), tagged @phone. One signed-in page serves the whole file (the owner, a shop with two products, a second shop with only an
 * archived product), set up once in beforeAll.
 *
 * Already scanned elsewhere, so not repeated here: the open-shop form without a shop, the loading skeletons, the refused page link, the inventory empty
 * states, the suspended and offline banners, the switcher at both widths (tests/visual/seller-shell.spec.ts, seller-inventory.spec.ts, W04 AS-01, AS-31, AS-32,
 * AS-86, AS-88, AS-98) and the orders states at phone width, dark mode and desktop (seller/orders/phone-a11y.spec.ts, orders.a11y.axe).
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page, state: string, info: TestInfo, selector?: string) {
  // contrast is measured from the colours on screen: let finite animations (a sheet sliding in) end first
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const builder = new AxeBuilder({ page }).withTags(TAGS).exclude('nextjs-portal');
  const { violations } = await (selector ? builder.include(selector) : builder).analyze();
  const line = (v: (typeof violations)[number]) => `${state}: ${v.id} (${v.impact}): ${v.help} [${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}]`;
  for (const v of violations.filter((entry) => entry.impact !== 'serious' && entry.impact !== 'critical')) info.annotations.push({ type: 'axe-minor', description: line(v) });
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map(line), state).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let shopA = '';
let shopB = '';
const titleA = uniqueTitle('A11y Mug');
const titleArchived = uniqueTitle('A11y Archived Mug');
let productA = '';

async function openAs(browser: Browser) {
  context = await browser.newContext();
  page = await context.newPage();
  const seeded = await ownerWithShop(page, [{ title: titleA, quantity: 4 }, { title: uniqueTitle('A11y Second Mug'), quantity: 0 }]);
  shopA = seeded.shopId;
  productA = seeded.productIds[0] as string;
  const second = await openSecondShop(seeded.member);
  shopB = second.shopId;
  // the archived product lives in the second shop; the owner token is the same
  const created = await (await import('./helpers')).sellerCall('POST', `/api/shops/${shopB}/products`, { title: titleArchived, brand: 'Test', category: 'a11y', priceMinor: 1999, quantity: 1, description: 'Archived by a test.' }, seeded.token);
  expect(created.status).toBe(201);
  await archiveByApi(seeded.token, shopB, created.data.id as string);
}

test.beforeAll(async ({ browser }) => {
  await openAs(browser);
});
test.afterAll(async () => {
  await context?.close();
});

test.describe('W04 AS-113 accessibility, one scan per state @desktop', () => {
  test('W04 AS-113 open-shop form: empty, with field errors, with the handle-taken answer', async ({ browser }, info) => {
    const fresh = await browser.newContext();
    try {
      const p = await fresh.newPage();
      await register(p);
      await resetRateLimits();
      await p.goto('/dashboard/seller');
      await expect(p.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
      await scan(p, 'open-shop form: empty', info);
      await p.getByRole('button', { name: 'Open shop' }).click();
      await expect(p.getByText('Enter a shop name of 2 to 80 characters.')).toBeVisible();
      await scan(p, 'open-shop form: field errors', info);
      const slug = `taken-${Date.now().toString(36)}`;
      await shopWithSlug(slug);
      await resetRateLimits();
      await p.getByLabel('Shop name').fill('A11y Shop');
      await p.getByLabel('Handle').fill(slug);
      await p.getByRole('button', { name: 'Open shop' }).click();
      await expect(p.getByLabel('Handle')).toHaveAttribute('aria-invalid', 'true');
      await scan(p, 'open-shop form: handle taken', info);
    } finally {
      await fresh.close();
    }
  });

  test('W04 AS-113 shop picker (two shops) and the shop-not-found page', async ({}, info) => {
    await page.goto('/dashboard/seller');
    await expect(page.getByRole('list', { name: 'Your shops' })).toBeVisible();
    await scan(page, 'picker', info);
    await page.goto(shopPath('11111111-1111-4111-8111-111111111111'));
    await expect(page.getByText("We couldn't find that shop.")).toBeVisible();
    await scan(page, 'shop not found', info);
  });

  test('W04 AS-113 list, row menu, add dialog with and without errors, edit dialog, stock popover, archive confirmation', async ({}, info) => {
    const title = titleA;
    await page.goto(shopPath(shopA, 'inventory'));
    await expect(page.getByRole('row').filter({ hasText: title })).toContainText('Low stock');
    await scan(page, 'inventory list', info);

    await page.getByRole('button', { name: `Actions for ${title}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeVisible();
    await scan(page, 'row menu open', info);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Add product' }).first().click();
    const add = page.getByRole('dialog', { name: 'Add product' });
    await expect(add).toBeVisible();
    await scan(page, 'add product dialog', info);
    await add.getByRole('button', { name: 'Create product' }).click();
    await expect(add.getByText('Fix the highlighted fields.')).toBeVisible();
    await scan(page, 'add product dialog with errors', info);
    await add.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.getByRole('button', { name: `Actions for ${title}` }).click();
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit product' });
    await expect(edit.getByLabel('Title')).toHaveValue(title);
    await scan(page, 'edit product dialog', info);
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.getByRole('button', { name: `Actions for ${title}` }).click();
    await page.getByRole('menuitem', { name: 'Adjust stock', exact: true }).click();
    await expect(page.getByLabel('New stock')).toBeVisible();
    await scan(page, 'stock popover', info);
    await page.getByLabel('New stock').fill('x');
    await page.getByRole('button', { name: 'Update stock' }).click();
    await expect(page.getByText('Enter a whole number, 0 or more.')).toBeVisible();
    await scan(page, 'stock popover with error', info);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('New stock')).toBeHidden();

    await page.getByRole('button', { name: `Actions for ${title}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Archive product?' })).toBeVisible();
    await scan(page, 'archive confirmation', info);
  });

  test('W04 AS-113 archived list with Restore, stock filters and the search that is too long', async ({}, info) => {
    const inventory = shopPath(shopB, 'inventory');
    await page.goto(`${inventory}?status=ARCHIVED`);
    await expect(page.getByRole('row').filter({ hasText: titleArchived })).toContainText('Archived');
    await page.getByRole('button', { name: `Actions for ${titleArchived}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Restore', exact: true })).toBeVisible();
    await scan(page, 'archived list, row menu with Restore', info);
    await page.keyboard.press('Escape');
    await page.goto(`${inventory}?status=ARCHIVED&inStock=true`);
    await scan(page, 'archived list with a stock filter', info);
    await page.goto(`${inventory}?q=zzzzqq`);
    await expect(page.getByText('No products match “zzzzqq”.')).toBeVisible();
    await scan(page, 'empty: search without hits', info);
    await page.goto(`${inventory}?q=${'a'.repeat(150)}`);
    await expect(page.getByRole('alert').first()).toBeVisible();
    await scan(page, 'error: search text too long', info);
  });

  test('W04 AS-113 photos page: empty, with a refused file, with a saved photo, and an unknown product', async ({}, info) => {
    await page.goto(shopPath(shopA, `products/${productA}/media`));
    await expect(page.getByText('No photos yet.')).toBeVisible();
    await scan(page, 'photos: empty', info);
    await page.getByLabel('Add photos').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') });
    await expect(page.getByText('Use a JPEG, PNG, WebP or AVIF image.')).toBeVisible();
    await scan(page, 'photos: refused file', info);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    // needs the media worker of the dev stack (READY)
    await page.getByLabel('Add photos').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PIXEL_PNG });
    await expect(page.getByRole('list', { name: 'Photos' }).getByRole('img')).toHaveCount(1, { timeout: 60_000 });
    await scan(page, 'photos: one photo in the draft', info);
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByText('Photos saved')).toBeVisible();
    await scan(page, 'photos: saved', info);
    await page.goto(shopPath(shopA, 'products/11111111-1111-4111-8111-111111111111/media'));
    await expect(page.getByRole('alert').first()).toBeVisible();
    await scan(page, 'photos: unknown product', info);
  });

  test('W04 AS-113 @phone drawer with the shop switcher open, and the filters sheet', async ({}, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(shopPath(shopA, 'inventory'));
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
    const menu = await sellerMenu(page);
    await scan(page, 'drawer open (phone)', info);
    await menu.getByRole('button', { name: /E2E Shop/ }).first().click();
    await expect(page.getByRole('list', { name: 'Your shops' })).toBeVisible();
    await scan(page, 'shop switcher open (phone)', info);
    await page.keyboard.press('Escape');
    if (await page.getByRole('dialog', { name: 'Seller menu' }).isVisible()) await closeMenu(page);
    const filters = await openFiltersIfCollapsed(page);
    await expect(filters.getByRole('tab', { name: 'Archived' })).toBeVisible();
    await scan(page, 'filters sheet (phone)', info);
  });
});
