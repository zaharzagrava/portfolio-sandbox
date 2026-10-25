import { expect, test, type Page } from '@playwright/test';
import { register } from '../../helpers';
import { ownerWithShop, watchApi } from '../cross-cutting/support';
import { openInventory, sql } from './support';
import { openRowAction, productRow } from './write-support';

/**
 * AI QA map `inventory`, section "rules": text rendered as text, parsed responses, messages by problem code, the rate-limit
 * countdown on a write, two tabs on one product, a sale lowering stock, dark mode. Each test has a shop of its own.
 */

const productUrl = /\/api\/shops\/[0-9a-f-]{36}\/products\/[0-9a-f-]{36}$/;
const MARKUP = '<img src=x onerror="window.__xss=1"><b>bold</b>';

async function noScriptRan(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
}

test.describe('Inventory rules', () => {
  test('[inventory.rules.text-as-text, inventory.rules.no-js-injection-search] seller text and the search text are shown as text in list, dialogs and the empty-search message; no markup runs', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.rules.text-as-text,inventory.rules.no-js-injection-search' });
    const popups: string[] = [];
    page.on('dialog', async (dialog) => {
      popups.push(dialog.message());
      await dialog.dismiss();
    });
    const { member, shopId } = await ownerWithShop(page, [{ title: MARKUP, quantity: 3 }]);
    await openInventory(page, member, shopId);
    await expect(page.getByRole('rowheader').filter({ hasText: 'bold' })).toHaveText(MARKUP);
    expect(await page.locator('tbody img, tbody b').count()).toBe(0);
    await openRowAction(page, MARKUP, 'Edit');
    const edit = page.getByRole('dialog', { name: 'Edit product' });
    await expect(edit.getByLabel('Title', { exact: true })).toHaveValue(MARKUP);
    await page.keyboard.press('Escape');
    await openRowAction(page, MARKUP, 'Adjust stock');
    await expect(page.getByRole('dialog', { name: `Adjust stock of ${MARKUP}` })).toBeVisible();
    expect(await page.locator('[role="dialog"] img, [role="dialog"] b').count()).toBe(0);
    await page.keyboard.press('Escape');
    // search text with markup: the empty message shows it literally
    const typed = '"><svg onload="window.__xss=3"><script>window.__xss=4</script>zzqq';
    await openInventory(page, member, shopId, `?q=${encodeURIComponent(typed)}`);
    await expect(page.getByRole('region', { name: 'Products' })).toContainText(typed);
    expect(await page.locator('main img, #main-content svg[onload], #main-content script').count()).toBe(0);
    await page.getByLabel('Search your products').fill(typed);
    await expect(page.getByRole('region', { name: 'Products' })).toContainText(typed);
    await noScriptRan(page);
    expect(popups).toEqual([]);
  });

  test('[inventory.rules.contract-parse] an unexpected list or write answer shows a generic error, not a blank page', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.rules.contract-parse' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Parse Mug' }]);
    await openInventory(page, member, shopId);
    // a write answer of the wrong shape
    await page.route(productUrl, (route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ surprise: true }) }) : route.continue()));
    await openRowAction(page, 'Parse Mug', 'Adjust stock');
    const popover = page.getByRole('dialog', { name: 'Adjust stock of Parse Mug' });
    await popover.getByLabel('New stock').fill('2');
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(popover.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
    await page.unroute(productUrl);
    // a list answer of the wrong shape
    await page.route(/\/api\/shops\/[0-9a-f-]{36}\/products(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 1, title: 5 }], nextCursor: 7, extra: 'x' }) }));
    await page.goto(`${page.url().split('?')[0]}?status=ARCHIVED`);
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Products' }).getByRole('alert')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Products' }).getByRole('button', { name: 'Try again' })).toBeVisible();
    expect((await productRow((await sql<{ id: string }>(`SELECT id FROM "Product" WHERE "shopId" = $1`, [shopId]))[0].id)).quantity).toBe(5);
  });

  test('[inventory.rules.problem-copy-by-code] the words follow the problem code, never the server title or detail', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.rules.problem-copy-by-code' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Copy Mug' }]);
    await openInventory(page, member, shopId);
    await openRowAction(page, 'Copy Mug', 'Edit');
    const edit = page.getByRole('dialog', { name: 'Edit product' });
    await edit.getByLabel('Brand', { exact: true }).fill('Changed');
    await page.route(productUrl, (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 422, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'SERVER TITLE', detail: 'SERVER DETAIL', status: 422, code: 'currency_not_supported' }) })
        : route.continue(),
    );
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit.getByText("That currency isn't supported for products yet.")).toBeVisible();
    await expect(edit).not.toContainText('SERVER TITLE');
    await expect(edit).not.toContainText('SERVER DETAIL');
    // an unknown code on a 4xx falls back to the generic words
    await page.unroute(productUrl);
    await page.route(productUrl, (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 418, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'SERVER TITLE', detail: 'SERVER DETAIL', status: 418, code: 'teapot' }) })
        : route.continue(),
    );
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit.getByText("Something didn't work. Check the details and try again.")).toBeVisible();
    await expect(edit).not.toContainText('SERVER DETAIL');
  });

  test('[inventory.rules.rate-limit-countdown] a 429 on a write shows a countdown from Retry-After and the control is off until it ends', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.rules.rate-limit-countdown' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Slow Mug' }]);
    await openInventory(page, member, shopId);
    await openRowAction(page, 'Slow Mug', 'Edit');
    const edit = page.getByRole('dialog', { name: 'Edit product' });
    await edit.getByLabel('Brand', { exact: true }).fill('Changed');
    await page.route(productUrl, (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 429, contentType: 'application/problem+json', headers: { 'Retry-After': '4' }, body: JSON.stringify({ type: 'x', title: 'Too many', status: 429, code: 'rate_limited' }) })
        : route.continue(),
    );
    const save = edit.getByRole('button', { name: 'Save changes' });
    await save.click();
    await expect(edit.getByText(/^Too many requests\. Try again in [1-4] s\.$/)).toBeVisible();
    await expect(save, 'the control is off while the countdown runs').toBeDisabled();
    await expect(edit.getByText('You can try again now.')).toBeVisible({ timeout: 10_000 });
    await expect(save).toBeEnabled();
  });

  test('[inventory.rules.version-sent] two tabs editing the same product: exactly one wins, the other gets 409 and the database holds the winner', async ({ page, context }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.rules.version-sent' });
    const { member, shopId, productIds } = await ownerWithShop(page, [{ title: 'Twin Mug' }]);
    const second = await context.newPage();
    await openInventory(page, member, shopId);
    await second.goto(page.url());
    await expect(second.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
    const apiA = watchApi(page);
    const apiB = watchApi(second);
    for (const [tab, brand] of [[page, 'Brand A'], [second, 'Brand B']] as const) {
      await openRowAction(tab, 'Twin Mug', 'Edit');
      await tab.getByRole('dialog', { name: 'Edit product' }).getByLabel('Brand', { exact: true }).fill(brand);
    }
    await Promise.all([page.getByRole('button', { name: 'Save changes' }).click(), second.getByRole('button', { name: 'Save changes' }).click()]);
    await expect.poll(() => apiA.matching('PATCH', /\/products\//).length + apiB.matching('PATCH', /\/products\//).length).toBe(2);
    await expect.poll(() => [...apiA.matching('PATCH', /\/products\//), ...apiB.matching('PATCH', /\/products\//)].every((entry) => entry.status !== null)).toBe(true);
    const statuses = [...apiA.matching('PATCH', /\/products\//), ...apiB.matching('PATCH', /\/products\//)].map((entry) => entry.status).sort();
    expect(statuses).toEqual([200, 409]);
    const row = await productRow(productIds[0]);
    expect(row.version).toBe(2);
    expect(['Brand A', 'Brand B']).toContain(row.brand);
  });

  test('[inventory.rules.dark-and-contrast] in dark mode the status is a word and labels, alerts and badges keep a readable contrast', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.rules.dark-and-contrast' });
    await page.emulateMedia({ colorScheme: 'dark' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Dark In', quantity: 20 }, { title: 'Dark Low', quantity: 2 }, { title: 'Dark Out', quantity: 0 }]);
    await openInventory(page, member, shopId);
    const ratio = (locator: ReturnType<Page['locator']>) =>
      locator.evaluate((node) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        const rgba = (color: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = '#000';
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
          return [r, g, b, a / 255];
        };
        let background = [0, 0, 0];
        const layers: number[][] = [];
        for (let el: Element | null = node; el; el = el.parentElement) {
          const c = rgba(getComputedStyle(el).backgroundColor);
          if (c[3] > 0) layers.push(c);
          if (c[3] >= 1) break;
        }
        for (const [r, g, b, a] of layers.reverse()) background = [r * a + background[0] * (1 - a), g * a + background[1] * (1 - a), b * a + background[2] * (1 - a)];
        const [fr, fg, fb, fa] = rgba(getComputedStyle(node).color);
        const text = [fr * fa + background[0] * (1 - fa), fg * fa + background[1] * (1 - fa), fb * fa + background[2] * (1 - fa)];
        const lum = ([r, g, b]: number[]) => [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const [hi, lo] = [lum(text), lum(background)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      });
    for (const [title, word] of [['Dark In', 'In stock'], ['Dark Low', 'Low stock'], ['Dark Out', 'Out of stock']]) {
      const label = page.getByRole('row', { name: new RegExp(title) }).getByText(word, { exact: true });
      await expect(label, `${title} shows the word`).toBeVisible();
      expect(await ratio(label), `${word} contrast`).toBeGreaterThanOrEqual(4.5);
    }
    expect(await ratio(page.getByRole('rowheader', { name: 'Dark In' }))).toBeGreaterThanOrEqual(4.5);
    // an alert: the stock popover conflict note and the error panel
    await page.route(productUrl, (route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'Boom', status: 500, code: 'internal_error' }) }) : route.continue()));
    await openRowAction(page, 'Dark In', 'Adjust stock');
    const popover = page.getByRole('dialog', { name: 'Adjust stock of Dark In' });
    await popover.getByLabel('New stock').fill('5');
    await popover.getByRole('button', { name: 'Update stock' }).click();
    const alertText = popover.getByRole('alert').locator('p').first();
    await expect(alertText).toBeVisible();
    expect(await ratio(alertText), 'alert contrast').toBeGreaterThanOrEqual(4.5);
    await popover.getByLabel('New stock').fill('x');
    await popover.getByRole('button', { name: 'Update stock' }).click();
    const error = popover.getByText('Enter a whole number, 0 or more.');
    expect(await ratio(error), 'field error contrast').toBeGreaterThanOrEqual(4.5);
  });

  test('[inventory.rules.stock-vs-sales] a sale lowers the stock: the list shows the new number after a refetch and a stale edit gets version_conflict', async ({ page, browser }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.rules.stock-vs-sales' });
    test.setTimeout(120_000);
    const { member, shopId, productIds } = await ownerWithShop(page, [{ title: 'Sale Mug', quantity: 10, priceMinor: 1500 }]);
    const id = productIds[0];
    await openInventory(page, member, shopId);
    await openRowAction(page, 'Sale Mug', 'Edit');
    const edit = page.getByRole('dialog', { name: 'Edit product' });
    await edit.getByLabel('Title', { exact: true }).fill('Sale Mug 2');
    // a buyer orders 2 units
    const buyerContext = await browser.newContext();
    try {
      const buyer = await buyerContext.newPage();
      await buyer.addInitScript(() => {
        navigator.sendBeacon = () => false;
      });
      await register(buyer);
      await buyer.goto(`/products/${id}`);
      await buyer.getByRole('button', { name: 'Add to cart' }).click();
      await expect(buyer.getByText('Added to cart')).toBeVisible();
      await buyer.goto('/checkout');
      await buyer.getByRole('button', { name: 'Place order' }).click();
      await expect(buyer).toHaveURL(/\/checkout\/pay\/[0-9a-f-]{36}$/);
    } finally {
      await buyerContext.close();
    }
    const after = await productRow(id);
    expect(after.quantity, 'the sale took one unit').toBe(9);
    expect(after.version, 'and bumped the version').toBeGreaterThan(1);
    // the stale edit is refused
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit.getByText('This product changed since you opened it.')).toBeVisible();
    expect((await productRow(id)).title).toBe('Sale Mug');
    // the list shows the new number after a refetch
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await openInventory(page, member, shopId);
    await expect(page.getByRole('row', { name: /Sale Mug/ })).toContainText('9');
  });
});
