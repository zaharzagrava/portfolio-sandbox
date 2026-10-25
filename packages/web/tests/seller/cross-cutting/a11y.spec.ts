import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { SEED, WIDTHS, closeMenu, login, openFiltersIfCollapsed, register, resetRateLimits, sellerMenu, shopPath } from '../../helpers';
import { PIXEL_PNG, archiveByApi, openSecondShop, orderInSeededShop, ownerWithShop, setSuspended, shopWithSlug, uniqueTitle } from './support';

/**
 * Track 6: an axe scan of every reachable state of the pages of the four seller areas (entry, inventory, media, orders).
 * The `mobile` (390 px) and `desktop` (1280 px) projects run every test, so each state is scanned at both widths; the shell
 * and the drawer test also switch width inside the test, so they cover both widths in any project (the Firefox and WebKit
 * projects included). A serious or critical finding fails the test. Moderate and minor findings do not fail it: they are
 * written to the test's annotations (type `axe-minor`) so the owner can read them in the report.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Scans the page (or one region) and fails on serious or critical findings; names the state so a failure says where. */
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

test.describe('Accessibility: entry (open-shop form, picker, shell)', () => {
  test('open-shop form: empty, with field errors, with the handle-taken answer', async ({ page }, info) => {
    await register(page);
    await resetRateLimits();
    await page.goto('/dashboard/seller');
    await expect(page.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
    await scan(page, 'open-shop form: empty', info);

    await page.getByRole('button', { name: 'Open shop' }).click();
    await expect(page.getByText('Enter a shop name of 2 to 80 characters.')).toBeVisible();
    await scan(page, 'open-shop form: field errors', info);

    const slug = `taken-${Date.now().toString(36)}`;
    await shopWithSlug(slug);
    await resetRateLimits();
    await page.getByLabel('Shop name').fill('A11y Shop');
    await page.getByLabel('Handle').fill(slug);
    await page.getByRole('button', { name: 'Open shop' }).click();
    await expect(page.getByLabel('Handle')).toHaveAttribute('aria-invalid', 'true');
    await scan(page, 'open-shop form: handle taken', info);
  });

  test('shop picker (two shops) and the shop-not-found page', async ({ page }, info) => {
    const { member } = await ownerWithShop(page);
    await openSecondShop(member);
    await page.goto('/dashboard/seller');
    await expect(page.getByRole('list', { name: 'Your shops' })).toBeVisible();
    await scan(page, 'picker', info);

    await page.goto(shopPath('11111111-1111-4111-8111-111111111111'));
    await expect(page.getByText("We couldn't find that shop.")).toBeVisible();
    await scan(page, 'shop not found', info);
  });

  test('shell: overview with the sidebar at desktop width and the top bar and drawer at 390 px, switcher open', async ({ page }, info) => {
    const { member, shopId } = await ownerWithShop(page);
    await openSecondShop(member);
    for (const width of ['desktop', 'mobile'] as const) {
      await page.setViewportSize(WIDTHS[width]);
      await page.goto(shopPath(shopId, 'inventory'));
      await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
      await scan(page, `shell closed (${width})`, info);

      const menu = await sellerMenu(page);
      await scan(page, `shell menu open (${width})`, info);
      await menu.getByRole('button', { name: /E2E Shop/ }).first().click();
      await expect(page.getByRole('list', { name: 'Your shops' })).toBeVisible();
      await scan(page, `shop switcher open (${width})`, info);
      await page.keyboard.press('Escape');
      if (width === 'mobile' && (await page.getByRole('dialog', { name: 'Seller menu' }).isVisible())) await closeMenu(page);
    }
  });

  test('shell: suspended banner and offline banner', async ({ page, context }, info) => {
    const { shopId } = await ownerWithShop(page);
    await setSuspended(shopId, true);
    try {
      await page.goto(shopPath(shopId));
      await expect(page.getByLabel('Shop status')).toHaveText('This shop is suspended. You can view data but not make changes.');
      await scan(page, 'suspended banner', info);
    } finally {
      await setSuspended(shopId, false);
    }
    await page.goto(shopPath(shopId));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await context.setOffline(true);
    try {
      await expect(page.getByText("You're offline. Changes can't be saved.")).toBeVisible();
      await scan(page, 'offline banner', info);
    } finally {
      await context.setOffline(false);
    }
  });
});

test.describe('Accessibility: inventory (every dialog and state)', () => {
  test('list, row menu, add dialog with and without errors, edit dialog, stock popover, archive confirmation', async ({ page }, info) => {
    const title = uniqueTitle('A11y Mug');
    const { shopId } = await ownerWithShop(page, [{ title, quantity: 4 }, { title: uniqueTitle('A11y Second Mug'), quantity: 0 }]);
    await page.goto(shopPath(shopId, 'inventory'));
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

    await page.getByRole('button', { name: `Actions for ${title}` }).click();
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Archive product?' })).toBeVisible();
    await scan(page, 'archive confirmation', info);
  });

  test('filters sheet (phone), search, archived list with Restore, and every empty and error state', async ({ page }, info) => {
    const title = uniqueTitle('A11y Archived Mug');
    const { shopId, token, productIds } = await ownerWithShop(page, [{ title }]);
    await archiveByApi(token, shopId, productIds[0] as string);
    const inventory = shopPath(shopId, 'inventory');

    await page.goto(inventory);
    await expect(page.getByText('No products yet.')).toBeVisible();
    await scan(page, 'empty: no products', info);

    const filters = await openFiltersIfCollapsed(page);
    await expect(filters.getByRole('tab', { name: 'Archived' })).toBeVisible();
    await scan(page, 'filters (sheet on the phone, sidebar on desktop)', info);
    await filters.getByRole('tab', { name: 'Archived' }).click();
    await expect(page).toHaveURL(/status=ARCHIVED/);
    if (await page.getByRole('dialog', { name: 'Filters' }).isVisible()) await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('row').filter({ hasText: title })).toContainText('Archived');
    await page.getByRole('button', { name: `Actions for ${title}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Restore', exact: true })).toBeVisible();
    await scan(page, 'archived list, row menu with Restore', info);
    await page.keyboard.press('Escape');

    await page.goto(`${inventory}?status=ARCHIVED&inStock=true`);
    await scan(page, 'archived list with a stock filter', info);
    await page.goto(`${inventory}?inStock=true`);
    await expect(page.getByText('No products match these filters.')).toBeVisible();
    await scan(page, 'empty: no match for the filters', info);
    await page.goto(`${inventory}?q=zzzzqq`);
    await expect(page.getByText('No products match “zzzzqq”.')).toBeVisible();
    await scan(page, 'empty: search without hits', info);
    await page.goto(`${inventory}?status=ARCHIVED&inStock=false`);
    await scan(page, 'archived, out-of-stock filter', info);
    await page.goto(`${inventory}?cursor=bogus`);
    await expect(page.getByText('That page link is no longer valid.')).toBeVisible();
    await scan(page, 'error: refused page link', info);
    await page.goto(`${inventory}?q=${'a'.repeat(150)}`);
    await expect(page.getByRole('alert').first()).toBeVisible();
    await scan(page, 'error: search text too long', info);
  });
});

test.describe('Accessibility: media (product photos page)', () => {
  test('photos page: empty, with a refused file, and with a saved photo', async ({ page }, info) => {
    const title = uniqueTitle('A11y Photo Mug');
    const { shopId, productIds } = await ownerWithShop(page, [{ title }]);
    const id = productIds[0] as string;
    await page.goto(shopPath(shopId, `products/${id}/media`));
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
  });

  test('photos page of an unknown product (error state)', async ({ page }, info) => {
    const { shopId } = await ownerWithShop(page);
    await page.goto(shopPath(shopId, 'products/11111111-1111-4111-8111-111111111111/media'));
    await expect(page.getByRole('alert').first()).toBeVisible();
    await scan(page, 'photos: unknown product', info);
  });
});

test.describe('Accessibility: orders', () => {
  test('orders: empty, filtered empty, refused page link and the filter control', async ({ page }, info) => {
    const { shopId } = await ownerWithShop(page);
    const orders = shopPath(shopId, 'orders');
    await page.goto(orders);
    await expect(page.getByText('No orders yet.')).toBeVisible();
    await scan(page, 'orders: empty', info);
    await page.getByLabel('Status').focus();
    await scan(page, 'orders: filter focused', info);
    await page.getByLabel('Status').selectOption('PAID');
    await expect(page).toHaveURL(/status=PAID/);
    await expect(page.getByText('No orders match this status.')).toBeVisible();
    await scan(page, 'orders: no order with this status', info);
    await page.goto(`${orders}?cursor=bogus`);
    await expect(page.getByText('That page link is no longer valid.')).toBeVisible();
    await scan(page, 'orders: refused page link', info);
  });

  test('orders: a shop with an order (table on desktop, cards on the phone)', async ({ page, browser }, info) => {
    const seeded = await orderInSeededShop(browser);
    await resetRateLimits();
    await login(page, SEED.seller, SEED.password, shopPath(seeded.shopId, 'orders'));
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Orders' }).getByRole('row').nth(1)).toBeVisible();
    await scan(page, 'orders: list', info);
    await page.getByLabel('Status').selectOption('PENDING');
    await expect(page).toHaveURL(/status=PENDING/);
    await scan(page, 'orders: filtered list or empty result', info);
  });
});
