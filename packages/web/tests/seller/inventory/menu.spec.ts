import { expect, test, type Page } from '@playwright/test';
import { sellerCall, shopPath } from '../../helpers';
import { archiveByApi, ownerWithShop, setSuspended, tokenOf, watchApi } from '../cross-cutting/support';
import { openInventory, proOwner, seedAll, sql } from './support';

/**
 * AI QA map `inventory`, sections "search (rate limit, paging, row actions)", "menu" and "stock popover (open)": the row menu,
 * its items by status and role, the way into each dialog and page, Restore (single request, failures), a suspended shop,
 * and the shop search at its limits. Each test uses a shop of its own.
 */

const INDEX_WAIT = { timeout: 90_000 };
const search = (page: Page) => page.getByLabel('Search your products');
const region = (page: Page) => page.getByRole('region', { name: 'Products' });
const menuButton = (page: Page, title: string) => page.getByRole('button', { name: `Actions for ${title}`, exact: true });
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 640;
const items = (page: Page) => page.getByRole('menuitem').allInnerTexts();

test.describe('Shop search: limits, paging and row actions', () => {
  test('[inventory.search.rate-limit] past the search limit the API answers 429 and the page shows a countdown, not a crash', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.rate-limit' });
    test.setTimeout(150_000);
    // The stack's API lets the loopback address through (RATE_LIMIT_ALLOW_IPS), so the 429 itself is stubbed; the page's reaction is what is checked.
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Limit Mug' }]);
    await openInventory(page, member, shopId);
    await page.route(/\/products\/search/, (route) => route.fulfill({ status: 429, contentType: 'application/problem+json', headers: { 'Retry-After': '20' }, body: JSON.stringify({ type: 'x', title: 'Too many', status: 429, code: 'rate_limited' }) }));
    await search(page).fill('Limit');
    await expect(region(page).getByText(/^Too many requests\. Try again in \d+ s\.$/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
    await expect(search(page)).toHaveValue('Limit');
  });

  test('[inventory.search.paging, inventory.search.row-actions] 25 hits come as 20 and 5 with a cursor bound to the text; an archived hit offers only Restore (version read first), an active one the full menu', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.search.paging,inventory.search.row-actions' });
    test.setTimeout(180_000);
    const { member, shopId } = await proOwner(page);
    const token = await tokenOf(member);
    const ids = await seedAll(member, shopId, Array.from({ length: 25 }, (_, i) => ({ title: `Zebra ${String(i).padStart(2, '0')}` })));
    await archiveByApi(token, shopId, ids[0]); // Zebra 00 is archived
    await expect.poll(async () => Number((await sql(`SELECT count(*)::int AS n FROM "SearchShopProduct" WHERE "shopId" = $1`, [shopId]))[0].n), INDEX_WAIT).toBe(25);
    await expect.poll(async () => (await sql(`SELECT status FROM "SearchShopProduct" WHERE "productId" = $1`, [ids[0]]))[0]?.status, INDEX_WAIT).toBe('ARCHIVED');
    await openInventory(page, member, shopId, '?q=Zebra');
    await expect(region(page).getByRole('row')).toHaveCount(21);
    const first = await page.locator('tbody tr').evaluateAll((rows) => rows.map((row) => row.children[0].textContent));
    const next = page.getByRole('link', { name: 'Next page' });
    const href = (await next.getAttribute('href')) ?? '';
    expect(new URL(href, page.url()).searchParams.get('q')).toBe('Zebra');
    const cursor = new URL(href, page.url()).searchParams.get('cursor') ?? '';
    expect(cursor.length).toBeGreaterThan(5);
    await next.click();
    await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
    const second = await page.locator('tbody tr').evaluateAll((rows) => rows.map((row) => row.children[0].textContent));
    expect(second.length).toBe(5);
    expect(new Set([...first, ...second]).size).toBe(25);
    await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
    // the cursor belongs to the text: another text with the same cursor is refused
    const mixed = await sellerCall('GET', `/api/shops/${shopId}/products/search?q=Other&limit=20&cursor=${encodeURIComponent(cursor)}`, undefined, token);
    expect([mixed.status, mixed.data.code], JSON.stringify(mixed.data)).toEqual([422, 'invalid_cursor']);

    // row actions of a search result
    await openInventory(page, member, shopId, '?q=Zebra 00');
    await expect(page.getByRole('rowheader', { name: 'Zebra 00' })).toBeVisible();
    await menuButton(page, 'Zebra 00').click();
    expect(await items(page)).toEqual(['Restore']);
    await page.keyboard.press('Escape');
    await openInventory(page, member, shopId, '?q=Zebra 01');
    await menuButton(page, 'Zebra 01').click();
    expect(await items(page)).toEqual(['Edit', 'Adjust stock', 'Photos and video', 'Edit together', 'Archive']);
    await page.keyboard.press('Escape');

    // Restore from a search row: the version is read first, then one restore
    await openInventory(page, member, shopId, '?q=Zebra 00');
    const api = watchApi(page);
    await menuButton(page, 'Zebra 00').click();
    await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
    await expect(page.getByText('Product restored')).toBeVisible();
    expect(api.count('GET', new RegExp(`/products/${ids[0]}$`))).toBe(1);
    expect(api.count('POST', new RegExp(`/products/${ids[0]}/restore$`))).toBe(1);
    expect((await sql(`SELECT status, version FROM "Product" WHERE id = $1`, [ids[0]]))[0]).toMatchObject({ status: 'ACTIVE', version: 3 });
  });
});

test.describe('Row menu', () => {
  test('[inventory.menu.trigger, inventory.menu.active-items, inventory.menu.archived-items, inventory.menu.edit-item, inventory.menu.adjust-item, inventory.stock.popover-open] the trigger is named after the row, opens with Enter/Space, arrows move, Escape returns focus; items by status; Edit and Adjust stock open their parts', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.trigger,inventory.menu.active-items,inventory.menu.archived-items,inventory.menu.edit-item,inventory.menu.adjust-item,inventory.stock.popover-open' });
    let focusAfterEdit = '';
    const { member, shopId, token, productIds } = await ownerWithShop(page, [{ title: 'Menu Mug', quantity: 4 }, { title: 'Old Mug', quantity: 2 }]);
    await archiveByApi(token, shopId, productIds[1]);
    await openInventory(page, member, shopId);
    const button = menuButton(page, 'Menu Mug');
    await expect(button).toBeVisible();
    // keyboard: Enter opens, arrows move, Escape closes and returns focus
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await items(page)).toEqual(['Edit', 'Adjust stock', 'Photos and video', 'Edit together', 'Archive']);
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Adjust stock', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused();
    expect(await page.getByRole('menuitem', { name: 'Archive', exact: true }).evaluate((node) => node.getAttribute('data-variant'))).toBe('destructive');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(button).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');

    if (isPhone(page)) {
      const card = await button.locator('xpath=ancestor::tr').boundingBox();
      const box = await button.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeGreaterThan(((card?.x ?? 0) + (card?.width ?? 0)) - 40); // right edge
      expect((box?.y ?? 0) - (card?.y ?? 0)).toBeLessThan(40); // top
    }

    await openInventory(page, member, shopId, '?status=ARCHIVED');
    await menuButton(page, 'Old Mug').click();
    expect(await items(page)).toEqual(['Restore']);
    await page.keyboard.press('Escape');

    // Edit opens the Edit dialog of that row
    await openInventory(page, member, shopId);
    await button.click();
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit product' });
    await expect(edit).toBeVisible();
    await expect(edit.getByLabel('Title', { exact: true })).toHaveValue('Menu Mug');
    await page.keyboard.press('Escape');
    await expect(edit).toHaveCount(0);
    focusAfterEdit = await page.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.getAttribute('aria-label') ?? ''}`);

    // Adjust stock opens the popover on the stock cell, prefilled; closing returns focus to the menu button
    await button.click();
    await page.getByRole('menuitem', { name: 'Adjust stock', exact: true }).click();
    const popover = page.getByRole('dialog', { name: 'Adjust stock of Menu Mug' });
    await expect(popover).toBeVisible();
    await expect(popover.getByLabel('New stock')).toHaveValue('4');
    const cell = await page.getByRole('row', { name: /Menu Mug/ }).locator('td, [role="cell"]').nth(2).boundingBox();
    const pop = await popover.boundingBox();
    expect(Math.abs((pop?.y ?? 0) - ((cell?.y ?? 0) + (cell?.height ?? 0))), 'popover hangs under the stock cell').toBeLessThan(200);
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(button).toBeFocused();
    test.info().annotations.push({ type: 'focus-after-edit-dialog', description: focusAfterEdit });
  });

  test('[inventory.menu.edit-item] closing the Edit dialog returns focus to the row\'s menu button (W04.R-24)', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.edit-item-focus' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Focus Mug' }]);
    await openInventory(page, member, shopId);
    await menuButton(page, 'Focus Mug').click();
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Edit product' }).getByLabel('Title', { exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Edit product' })).toHaveCount(0);
    await expect(menuButton(page, 'Focus Mug')).toBeFocused();
  });

  test('[inventory.menu.photos-item, inventory.menu.draft-item] Photos and video and Edit together go to their pages', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.photos-item,inventory.menu.draft-item' });
    const { member, shopId, productIds } = await ownerWithShop(page, [{ title: 'Way Mug' }]);
    await openInventory(page, member, shopId);
    await menuButton(page, 'Way Mug').click();
    await page.getByRole('menuitem', { name: 'Photos and video', exact: true }).click();
    await expect(page).toHaveURL(`${shopPath(shopId, `products/${productIds[0]}/media`)}`.replace(/^/, 'http://localhost:3000'));
    await openInventory(page, member, shopId);
    await menuButton(page, 'Way Mug').click();
    await page.getByRole('menuitem', { name: 'Edit together', exact: true }).click();
    await expect(page).toHaveURL(`http://localhost:3000${shopPath(shopId, `products/${productIds[0]}/draft`)}`);
  });

  test('[inventory.menu.restore-item, inventory.menu.restore-double-press] Restore sends one request even when pressed twice, shows the toast, moves the row to Active; status ACTIVE, version +1, history row', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.restore-item,inventory.menu.restore-double-press' });
    const { member, shopId, token, productIds } = await ownerWithShop(page, [{ title: 'Back Mug' }]);
    await archiveByApi(token, shopId, productIds[0]);
    const before = (await sql<{ version: number }>(`SELECT version FROM "Product" WHERE id = $1`, [productIds[0]]))[0].version;
    await openInventory(page, member, shopId, '?status=ARCHIVED');
    const api = watchApi(page);
    await page.route(/\/products\/[^/]+\/restore$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600)); // keep the first restore running while the second is chosen
      await route.continue();
    });
    await menuButton(page, 'Back Mug').click();
    await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
    // a second choice while the first runs (the menu is still reachable on the row)
    const again = menuButton(page, 'Back Mug');
    if (await again.count()) {
      await again.click({ timeout: 2000 }).catch(() => undefined);
      await page.getByRole('menuitem', { name: 'Restore', exact: true }).click({ timeout: 2000 }).catch(() => undefined);
    }
    await expect(page.getByText('Product restored').first()).toBeVisible();
    await expect(page.getByRole('rowheader', { name: 'Back Mug' })).toHaveCount(0); // left the Archived tab
    expect(api.count('POST', /\/restore$/)).toBe(1);
    await expect(region(page).getByRole('alert')).toHaveCount(0);
    expect((await sql(`SELECT status, version FROM "Product" WHERE id = $1`, [productIds[0]]))[0]).toMatchObject({ status: 'ACTIVE', version: before + 1 });
    const history = await sql<{ fromStatus: string; toStatus: string }>(`SELECT "fromStatus", "toStatus" FROM "ProductStatusHistory" WHERE "productId" = $1 ORDER BY at`, [productIds[0]]);
    expect(history.at(-1)).toMatchObject({ fromStatus: 'ARCHIVED', toStatus: 'ACTIVE' });
    await openInventory(page, member, shopId);
    await expect(page.getByRole('rowheader', { name: 'Back Mug' })).toBeVisible();
  });

  test('[inventory.menu.restore-failure] a failed Restore shows the problem above the list; a stale answer says the product changed elsewhere and the list refetches; 429 counts down; 5xx has a reference', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.restore-failure' });
    const { member, shopId, token, productIds } = await ownerWithShop(page, [{ title: 'Fail Mug' }]);
    await archiveByApi(token, shopId, productIds[0]);
    const answers: { status: number; code: string; headers?: Record<string, string>; text: RegExp }[] = [
      { status: 409, code: 'invalid_transition', text: /^This product was archived or restored elsewhere\. The list has been refreshed\.$/ },
      { status: 409, code: 'version_conflict', text: /^This product changed since you opened it\.$/ },
      { status: 403, code: 'permission_denied', text: /^You don't have access to this page\.$/ },
      { status: 429, code: 'rate_limited', headers: { 'Retry-After': '20' }, text: /^Too many requests\. Try again in \d+ s\.$/ },
      { status: 500, code: 'internal_error', text: /^Something went wrong on our side\.$/ },
    ];
    const texts: string[] = [];
    for (const answer of answers) {
      await openInventory(page, member, shopId, '?status=ARCHIVED');
      await page.route(/\/products\/[^/]+\/restore$/, (route) => route.fulfill({ status: answer.status, contentType: 'application/problem+json', headers: answer.headers, body: JSON.stringify({ type: 'x', title: 'x', status: answer.status, code: answer.code, requestId: 'req-test-123' }) }));
      const api = watchApi(page);
      await menuButton(page, 'Fail Mug').click();
      await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
      const shown = page.locator('#main-content').locator('p').filter({ hasText: answer.text }).first();
      await expect(shown, `${answer.status} ${answer.code}`).toBeVisible();
      texts.push(`${answer.code}: ${(await shown.innerText()).trim()}`);
      if (answer.status === 500) await expect(page.getByText('Reference: req-test-123')).toBeVisible();
      if (answer.code === 'invalid_transition') await expect.poll(() => api.count('GET', /\/products$/), { message: 'the list refetches' }).toBeGreaterThan(0);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
    test.info().annotations.push({ type: 'copy-seen', description: texts.join(' | ') });
    expect(await sql(`SELECT 1 FROM "Product" WHERE id = $1 AND status = 'ARCHIVED'`, [productIds[0]])).toHaveLength(1);
  });

  test('[inventory.menu.problem-cleared] choosing another menu item clears the previous problem alert', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.problem-cleared' });
    const { member, shopId, token, productIds } = await ownerWithShop(page, [{ title: 'Clear Mug' }, { title: 'Next Mug' }]);
    await archiveByApi(token, shopId, productIds[0]);
    await archiveByApi(token, shopId, productIds[1]);
    await openInventory(page, member, shopId, '?status=ARCHIVED');
    await page.route(/\/products\/[^/]+\/restore$/, (route) => route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'x', status: 500, code: 'internal_error', requestId: 'req-x' }) }));
    await menuButton(page, 'Clear Mug').click();
    await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
    await expect(page.getByText('Something went wrong on our side.')).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await menuButton(page, 'Next Mug').click();
    await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
    await expect(page.getByText('Something went wrong on our side.')).toHaveCount(0); // the new action cleared the old problem
    await expect(page.getByText('Product restored')).toBeVisible();
  });

  test('[inventory.menu.suspended] on a suspended shop the banner shows, Add product is disabled with the note, and the list stays readable (B-024: the list call answers 403)', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.menu.suspended,inventory.add.button-suspended-closing' });
    const { member, shopId } = await proOwner(page);
    await seedAll(member, shopId, [{ title: 'Susp Mug' }]);
    await setSuspended(shopId, true);
    await openInventory(page, member, shopId);
    await expect(page.getByText(/This shop is suspended/).first()).toBeVisible();
    const add = page.getByRole('button', { name: 'Add product' }).first();
    await expect(add).toBeDisabled();
    await expect(add).toHaveAccessibleDescription(/This shop is suspended/);
    // the list must stay readable and the row menu disabled with the reason on top
    await expect(page.getByRole('rowheader', { name: 'Susp Mug' })).toBeVisible();
    await menuButton(page, 'Susp Mug').click();
    await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeDisabled();
    await expect(page.getByRole('menu')).toContainText('This shop is suspended');
  });

  test('[inventory.add.button-suspended-closing] on a closing shop the button is disabled and the note carries the closing text', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.button-suspended-closing-deleting' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Close Mug' }]);
    await sql(`UPDATE "Shop" SET status = 'DELETING' WHERE id = $1`, [shopId]);
    await openInventory(page, member, shopId);
    const add = page.getByRole('button', { name: 'Add product' }).first();
    await expect(add).toBeDisabled();
    await expect(add).toHaveAccessibleDescription(/This shop is being closed/);
    const status = await sellerCall('GET', `/api/shops/${shopId}/products`, undefined, await tokenOf(member));
    test.info().annotations.push({ type: 'list-status-on-closing-shop', description: String(status.status) });
    await expect(page.getByRole('rowheader', { name: 'Close Mug' })).toBeVisible();
  });
});
