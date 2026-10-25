import { expect, test, type Page } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { archiveByApi, ownerWithShop, setSuspended, tokenOf, watchApi } from '../cross-cutting/support';
import { openInventory, sql } from './support';
import { historyOf, indexRow, menuButton, openRowAction, outboxOf, productRow } from './write-support';

/**
 * AI QA map `inventory`, section "stock popover (Adjust stock)": the "Update stock" press and what it writes (row, version, outbox),
 * the field rules, Cancel, a double press, a search row without a version, the conflict and stale-row paths, other refusals.
 * Each test has a shop of its own.
 */

const popoverOf = (page: Page, title: string) => page.getByRole('dialog', { name: `Adjust stock of ${title}` });
const rowOf = (page: Page, title: string) => page.getByRole('row', { name: new RegExp(title) });
const stockPatches = (api: ReturnType<typeof watchApi>) => api.matching('PATCH', /\/products\/[0-9a-f-]{36}$/);

async function openAdjust(page: Page, title: string) {
  await openRowAction(page, title, 'Adjust stock');
  const popover = popoverOf(page, title);
  await expect(popover).toBeVisible();
  return popover;
}

test.describe('Adjust stock popover', () => {
  test('[inventory.stock.update-button, inventory.stock.low-label-after-change, inventory.rules.outbox-event-per-write, inventory.rules.invalidate-after-write, inventory.rules.search-index-follows] a valid number sends one PATCH with expectedVersion, writes quantity, version+1 and one outbox event; the label follows 3, 0, 8', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.stock.update-button,inventory.stock.low-label-after-change,inventory.rules.outbox-event-per-write,inventory.rules.invalidate-after-write,inventory.rules.search-index-follows' });
    test.setTimeout(150_000);
    const { member, shopId, productIds } = await ownerWithShop(page, [{ title: 'Stock Mug', quantity: 10 }]);
    const id = productIds[0];
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    const sent: { body: string | null; headers: Record<string, string> }[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH') sent.push({ body: request.postData(), headers: request.headers() });
    });

    let popover = await openAdjust(page, 'Stock Mug');
    await expect(popover.getByLabel('New stock')).toHaveValue('10');
    await popover.getByLabel('New stock').fill('3');
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(page.getByText('Stock updated')).toBeVisible();
    await expect(popover).toHaveCount(0);
    expect(stockPatches(api).map((entry) => entry.status)).toEqual([200]);
    expect(JSON.parse(sent[0].body ?? '{}')).toEqual({ expectedVersion: 1, quantity: 3 });
    await expect(rowOf(page, 'Stock Mug')).toContainText('Low stock');
    await expect(rowOf(page, 'Stock Mug')).toContainText('3');
    expect(api.count('GET', /\/products(\?|$)/), 'the list is read again after the write').toBeGreaterThanOrEqual(1);
    const after = await productRow(id);
    expect([after.quantity, after.version]).toEqual([3, 2]);
    let events = (await outboxOf(id)).filter((event) => event.eventName === 'catalog.product_updated');
    expect(events.map((event) => [event.topic, event.aggregateVersion, event.changedFields])).toEqual([['products.events', 2, ['quantity']]]);
    expect(events[0].quantity).toBe(3);
    await expect.poll(async () => (await indexRow(id))?.quantity, { timeout: 90_000 }).toBe(3);

    // 0 -> Out of stock, appears in the Out of stock filter
    popover = await openAdjust(page, 'Stock Mug');
    await popover.getByLabel('New stock').fill('0');
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(page.getByText('Stock updated').first()).toBeVisible();
    await expect(rowOf(page, 'Stock Mug')).toContainText('Out of stock');
    await openInventory(page, member, shopId, '?inStock=false');
    await expect(rowOf(page, 'Stock Mug')).toBeVisible();
    // 8 -> In stock, gone from the Out of stock filter
    await openInventory(page, member, shopId);
    popover = await openAdjust(page, 'Stock Mug');
    await popover.getByLabel('New stock').fill('8');
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(rowOf(page, 'Stock Mug')).toContainText('In stock');
    await openInventory(page, member, shopId, '?inStock=false');
    await expect(rowOf(page, 'Stock Mug')).toHaveCount(0);
    expect((await productRow(id)).version).toBe(4);
    events = (await outboxOf(id)).filter((event) => event.eventName === 'catalog.product_updated');
    expect(events.map((event) => event.aggregateVersion)).toEqual([2, 3, 4]);
  });

  test('[inventory.stock.validation] non-numbers, negative, decimals, empty and too large show the message with aria-invalid and send nothing', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.stock.validation' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Rule Mug', quantity: 4 }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    const popover = await openAdjust(page, 'Rule Mug');
    const field = popover.getByLabel('New stock');
    for (const bad of ['abc', '-1', '2.5', '', '   ', '1000000001', '99999999999', '1e3', '0x10']) {
      await field.fill(bad);
      await popover.getByRole('button', { name: 'Update stock' }).click();
      await expect(popover.getByText('Enter a whole number, 0 or more.'), `value "${bad}"`).toBeVisible();
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(field).toHaveAttribute('aria-describedby', /-error$/);
    }
    expect(stockPatches(api)).toHaveLength(0);
    // typing clears the message; the boundary values are accepted
    await field.fill('1000000000');
    await expect(popover.getByText('Enter a whole number, 0 or more.')).toHaveCount(0);
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(page.getByText('Stock updated')).toBeVisible();
    expect(stockPatches(api)).toHaveLength(1);
  });

  test('[inventory.stock.same-value] the same number sends a PATCH, answers 200, keeps the version, writes no event', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.stock.same-value' });
    const { member, shopId, productIds } = await ownerWithShop(page, [{ title: 'Same Mug', quantity: 6 }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    const popover = await openAdjust(page, 'Same Mug');
    const eventsBefore = (await outboxOf(productIds[0])).length;
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(page.getByText('Stock updated')).toBeVisible();
    expect(stockPatches(api).map((entry) => entry.status)).toEqual([200]);
    const row = await productRow(productIds[0]);
    expect([row.quantity, row.version]).toEqual([6, 1]);
    expect((await outboxOf(productIds[0])).length).toBe(eventsBefore);
  });

  test('[inventory.stock.cancel, inventory.rules.focus-return] Cancel, Escape and a click outside close the popover with no request; focus goes back to the row menu button', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.stock.cancel,inventory.rules.focus-return' });
    const { member, shopId, productIds } = await ownerWithShop(page, [{ title: 'Cancel Mug', quantity: 7 }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    const button = menuButton(page, 'Cancel Mug');
    let popover = await openAdjust(page, 'Cancel Mug');
    await popover.getByLabel('New stock').fill('1');
    await popover.getByRole('button', { name: 'Cancel' }).click();
    await expect(popover).toHaveCount(0);
    await expect(button).toBeFocused();
    popover = await openAdjust(page, 'Cancel Mug');
    await expect(popover.getByLabel('New stock'), 'a reopened popover starts from the stored number').toHaveValue('7');
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(button).toBeFocused();
    popover = await openAdjust(page, 'Cancel Mug');
    await page.getByRole('heading', { level: 1, name: 'Inventory' }).click();
    await expect(popover).toHaveCount(0);
    expect(stockPatches(api)).toHaveLength(0);
    expect((await productRow(productIds[0])).quantity).toBe(7);
  });

  test('[inventory.stock.double-press] two quick presses send one PATCH; the buttons are disabled and busy meanwhile', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.stock.double-press' });
    const { member, shopId, productIds } = await ownerWithShop(page, [{ title: 'Double Mug', quantity: 9 }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await page.route(/\/products\/[0-9a-f-]{36}$/, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return route.continue();
    });
    const popover = await openAdjust(page, 'Double Mug');
    await popover.getByLabel('New stock').fill('2');
    const update = popover.getByRole('button', { name: 'Update stock' });
    await update.dblclick(); // two presses a few milliseconds apart (a double click, or a held Enter key)
    await expect(update).toBeDisabled();
    await expect(update).toHaveAttribute('aria-busy', 'true');
    await expect(popover.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await expect(page.getByText('Stock updated')).toBeVisible();
    expect(stockPatches(api)).toHaveLength(1);
    const row = await productRow(productIds[0]);
    expect([row.quantity, row.version]).toEqual([2, 2]);
  });

  test('[inventory.stock.search-row-version, inventory.stock.stale-row] from a search row the product is read first, then PATCHed with that version; a product archived meanwhile closes the popover with the page alert', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.stock.search-row-version,inventory.stock.stale-row' });
    test.setTimeout(150_000);
    const { member, shopId, token, productIds } = await ownerWithShop(page, [{ title: 'Quartz Mug', quantity: 5 }, { title: 'Quartz Lamp', quantity: 5 }]);
    for (const id of productIds) await expect.poll(async () => (await indexRow(id))?.quantity, { timeout: 90_000 }).toBe(5);
    await openInventory(page, member, shopId, '?q=Quartz');
    await expect(rowOf(page, 'Quartz Mug')).toBeVisible();
    const api = watchApi(page);
    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH') sent.push(request.postData() ?? '');
    });
    // someone else changes the product after the search: the fresh read decides the version
    expect((await sellerCall('PATCH', `/api/shops/${shopId}/products/${productIds[0]}`, { expectedVersion: 1, title: 'Quartz Mug' }, token)).status).toBe(200);
    let popover = await openAdjust(page, 'Quartz Mug');
    await popover.getByLabel('New stock').fill('11');
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(page.getByText('Stock updated')).toBeVisible();
    expect(api.count('GET', new RegExp(`/products/${productIds[0]}$`))).toBe(1);
    expect(sent.map((body) => JSON.parse(body))).toEqual([{ expectedVersion: 1, quantity: 11 }]);
    expect((await productRow(productIds[0])).quantity).toBe(11);
    await expect(popover).toHaveCount(0);

    // stale: the second product is archived after the search page was drawn
    await archiveByApi(token, shopId, productIds[1]);
    api.reset();
    popover = await openAdjust(page, 'Quartz Lamp');
    await popover.getByLabel('New stock').fill('2');
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(page.getByText('This product was archived or restored elsewhere. The list has been refreshed.')).toBeVisible();
    await expect(popover).toHaveCount(0);
    expect(api.matching('PATCH', /\/products\//).map((entry) => entry.status)).toEqual([409]);
    expect((await productRow(productIds[1])).quantity).toBe(5);
  });

  test('[inventory.stock.version-conflict, inventory.rules.version-sent, inventory.rules.stock-vs-sales] a stale version gives "Stock changed to N", keeps the typed number, and the next press saves against the new version', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.stock.version-conflict,inventory.rules.version-sent,inventory.rules.stock-vs-sales' });
    const { member, shopId, token, productIds } = await ownerWithShop(page, [{ title: 'Race Mug', quantity: 10 }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH') sent.push(request.postData() ?? '');
    });
    const popover = await openAdjust(page, 'Race Mug');
    await popover.getByLabel('New stock').fill('4');
    // another writer (a sale, a second tab) changes the stock first
    expect((await sellerCall('PATCH', `/api/shops/${shopId}/products/${productIds[0]}`, { expectedVersion: 1, quantity: 9 }, token)).status).toBe(200);
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(popover.getByText('Stock changed to 9 while you were editing.')).toBeVisible();
    await expect(popover.getByLabel('New stock')).toHaveValue('4');
    expect(stockPatches(api).map((entry) => entry.status)).toEqual([409]);
    let row = await productRow(productIds[0]);
    expect([row.quantity, row.version], 'nothing overwritten').toEqual([9, 2]);
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(page.getByText('Stock updated')).toBeVisible();
    expect(sent.map((body) => JSON.parse(body))).toEqual([{ expectedVersion: 1, quantity: 4 }, { expectedVersion: 2, quantity: 4 }]);
    row = await productRow(productIds[0]);
    expect([row.quantity, row.version]).toEqual([4, 3]);
    expect((await outboxOf(productIds[0])).filter((event) => event.eventName === 'catalog.product_updated').map((event) => event.aggregateVersion)).toEqual([2, 3]);
    await expect(rowOf(page, 'Race Mug')).toContainText('Low stock');
  });

  test('[inventory.stock.other-errors] a suspended shop (real 403), a stubbed 429 and a stubbed 500 show a problem inside the popover and keep the number', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.stock.other-errors' });
    test.setTimeout(120_000);
    const { member, shopId, productIds } = await ownerWithShop(page, [{ title: 'Fail Mug', quantity: 8 }]);
    await openInventory(page, member, shopId);
    const productUrl = /\/products\/[0-9a-f-]{36}$/;
    const popover = await openAdjust(page, 'Fail Mug');
    // 500 (stub)
    await page.route(productUrl, (route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'Boom', status: 500, code: 'internal_error' }) }) : route.continue()));
    await popover.getByLabel('New stock').fill('3');
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(popover.getByRole('alert')).toContainText(/went wrong|try again/i);
    await expect(popover.getByLabel('New stock')).toHaveValue('3');
    await expect(popover).toBeVisible();
    await page.unroute(productUrl);
    // 429 (stub)
    await page.route(productUrl, (route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 429, contentType: 'application/problem+json', headers: { 'Retry-After': '30' }, body: JSON.stringify({ type: 'x', title: 'Too many', status: 429, code: 'rate_limited' }) }) : route.continue()));
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(popover.getByText(/^Too many requests\. Try again in \d+ s\.$/)).toBeVisible();
    await expect(popover.getByLabel('New stock')).toHaveValue('3');
    await page.unroute(productUrl);
    // 403 shop_suspended (stub: the list keeps working, so the popover stays)
    await page.route(productUrl, (route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 403, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'Forbidden', status: 403, code: 'shop_suspended' }) }) : route.continue()));
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(popover.getByText('This shop is suspended. You can view data but not make changes.')).toBeVisible();
    await expect(popover.getByLabel('New stock')).toHaveValue('3');
    const row = await productRow(productIds[0]);
    expect([row.quantity, row.version]).toEqual([8, 1]);
  });

  test('[inventory.stock.extra-1] a real suspension between opening and pressing keeps the explanation and the typed number in the popover', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.stock.extra-1' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Real Mug', quantity: 8 }]);
    await openInventory(page, member, shopId);
    const popover = await openAdjust(page, 'Real Mug');
    await popover.getByLabel('New stock').fill('3');
    await setSuspended(shopId, true);
    await popover.getByRole('button', { name: 'Update stock' }).click();
    await expect(popover.getByText('This shop is suspended. You can view data but not make changes.')).toBeVisible();
    await expect(popover.getByLabel('New stock')).toHaveValue('3');
  });

  test('[inventory.stock.archived-product-api, inventory.shop.suspended-api-writes] stock of an archived product is refused with 409 product_archived and a suspended shop with 403 shop_suspended; nothing changes', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.stock.archived-product-api,inventory.shop.suspended-api-writes' });
    const { member, shopId, token, productIds } = await ownerWithShop(page, [{ title: 'Gone Mug', quantity: 5 }, { title: 'Frozen Mug', quantity: 5 }]);
    void member;
    await archiveByApi(token, shopId, productIds[0]);
    const archived = await productRow(productIds[0]);
    const outboxBefore = (await outboxOf(productIds[0])).length;
    const refused = await sellerCall('PATCH', `/api/shops/${shopId}/products/${productIds[0]}`, { expectedVersion: archived.version, quantity: 1 }, token);
    expect([refused.status, refused.data.code], JSON.stringify(refused.data)).toEqual([409, 'product_archived']);
    expect((await productRow(productIds[0])).quantity).toBe(5);
    expect((await outboxOf(productIds[0])).length).toBe(outboxBefore);

    await setSuspended(shopId, true);
    const base = `/api/shops/${shopId}/products/${productIds[1]}`;
    const results = {
      patch: await sellerCall('PATCH', base, { expectedVersion: 1, quantity: 1 }, token),
      archive: await sellerCall('POST', `${base}/archive`, { expectedVersion: 1 }, token),
      restore: await sellerCall('POST', `${base}/restore`, { expectedVersion: 1 }, token),
      create: await sellerCall('POST', `/api/shops/${shopId}/products`, { title: 'New', brand: 'B', category: 'c', priceMinor: 100, quantity: 1 }, token),
    };
    for (const [name, result] of Object.entries(results)) expect([name, result.status, result.data.code], JSON.stringify(result.data)).toEqual([name, 403, 'shop_suspended']);
    const row = await productRow(productIds[1]);
    expect([row.quantity, row.version, row.status]).toEqual([5, 1, 'ACTIVE']);
    expect(Number((await sql(`SELECT count(*)::int AS n FROM "Product" WHERE "shopId" = $1`, [shopId]))[0].n)).toBe(2);
    expect(await historyOf(productIds[1])).toEqual([]);
  });
});

void tokenOf;
