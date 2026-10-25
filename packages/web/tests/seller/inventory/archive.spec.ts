import { expect, test, type Page } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { archiveByApi, ownerWithShop, watchApi } from '../cross-cutting/support';
import { openInventory, proOwner, seedAll } from './support';
import { historyOf, indexRow, menuButton, openRowAction, outboxOf, productRow } from './write-support';
import { userId } from '../support/db';

/**
 * AI QA map `inventory`, section "Archive": the confirmation dialog (focus on Cancel first), the single POST with expectedVersion
 * and what it writes (status, version, history row, outbox event, search index, public page), Cancel/Escape, a double press, a
 * product that changed or was archived elsewhere, and other refusals. Each test has a shop of its own.
 */

const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Archive product?' });
const archivePosts = (api: ReturnType<typeof watchApi>) => api.matching('POST', /\/products\/[0-9a-f-]{36}\/archive$/);
const archiveUrl = /\/products\/[0-9a-f-]{36}\/archive$/;

test.describe('Archive product dialog', () => {
  test('[inventory.archive.dialog-open] the dialog explains, focus starts on Cancel, Tab stays inside', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.archive.dialog-open' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Keep Mug' }]);
    await openInventory(page, member, shopId);
    await openRowAction(page, 'Keep Mug', 'Archive');
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('It disappears from the storefront and search. You can restore it.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Archive product' })).toBeEnabled();
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  });

  test('[inventory.archive.cancel] Cancel and Escape close the dialog with no request and give focus back to the row menu button', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.archive.cancel' });
    const { member, shopId, productIds } = await ownerWithShop(page, [{ title: 'Keep Mug' }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await openRowAction(page, 'Keep Mug', 'Archive');
    const dialog = dialogOf(page);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(menuButton(page, 'Keep Mug')).toBeFocused();
    await openRowAction(page, 'Keep Mug', 'Archive');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(menuButton(page, 'Keep Mug')).toBeFocused();
    expect(api.writes()).toHaveLength(0);
    expect(await productRow(productIds[0])).toMatchObject({ status: 'ACTIVE', version: 1 });
  });

  test('[inventory.archive.confirm, inventory.archive.double-press, inventory.archive.last-product-empty, inventory.archive.storefront-hidden, inventory.rules.outbox-event-per-write, inventory.rules.cache-invalidation, inventory.rules.search-index-follows] one POST with expectedVersion even on a double press; status, version, history row and outbox event; the row moves to Archived; hidden from the public page, still in seller search as Archived', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.archive.confirm,inventory.archive.double-press,inventory.archive.last-product-empty,inventory.archive.storefront-hidden,inventory.rules.outbox-event-per-write,inventory.rules.cache-invalidation,inventory.rules.search-index-follows' });
    test.setTimeout(180_000);
    const { member, shopId, productIds } = await ownerWithShop(page, [{ title: 'Onyx Mug', quantity: 5 }]);
    const id = productIds[0];
    expect((await sellerCall('GET', `/api/products/${id}`)).status, 'public page before').toBe(200);
    await expect.poll(async () => (await indexRow(id))?.status, { timeout: 90_000 }).toBe('ACTIVE');
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    const sent: string[] = [];
    page.on('request', (request) => {
      if (archiveUrl.test(new URL(request.url()).pathname)) sent.push(request.postData() ?? '');
    });
    await page.route(archiveUrl, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return route.continue();
    });
    await openRowAction(page, 'Onyx Mug', 'Archive');
    const confirm = dialogOf(page).getByRole('button', { name: 'Archive product' });
    await confirm.dblclick();
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAttribute('aria-busy', 'true');
    await expect(dialogOf(page).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await expect(page.getByText('Product archived')).toBeVisible();
    await expect(dialogOf(page)).toHaveCount(0);
    expect(archivePosts(api).map((entry) => entry.status)).toEqual([200]);
    expect(sent.map((body) => JSON.parse(body))).toEqual([{ expectedVersion: 1 }]);
    await expect(page.getByText('No products yet.')).toBeVisible(); // the only product left the Active view
    const row = await productRow(id);
    expect([row.status, row.version]).toEqual(['ARCHIVED', 2]);
    const history = await historyOf(id);
    expect(history).toEqual([{ fromStatus: 'ACTIVE', toStatus: 'ARCHIVED', productVersion: 2, actorId: userId(member.email) }]);
    const events = (await outboxOf(id)).filter((event) => event.eventName === 'catalog.product_archived');
    expect(events.map((event) => [event.topic, event.aggregateVersion, event.status])).toEqual([['products.events', 2, 'ARCHIVED']]);
    expect((await outboxOf(id)).filter((event) => event.aggregateVersion === 2)).toHaveLength(1);
    // Archived tab shows it
    await openInventory(page, member, shopId, '?status=ARCHIVED');
    await expect(page.getByRole('row', { name: /Onyx Mug/ })).toContainText('Archived');
    // storefront: the public page is gone at once, the seller search keeps it with the Archived label
    const publicPage = await sellerCall('GET', `/api/products/${id}`);
    expect(publicPage.status, JSON.stringify(publicPage.data).slice(0, 200)).toBe(404);
    await expect.poll(async () => (await indexRow(id))?.status, { timeout: 90_000 }).toBe('ARCHIVED');
    await openInventory(page, member, shopId, '?q=Onyx');
    await expect(page.getByRole('row', { name: /Onyx Mug/ })).toContainText('Archived');
    const publicSearch = await sellerCall('GET', `/api/products?q=Onyx`);
    expect(JSON.stringify(publicSearch.data)).not.toContain(id);
  });

  test('[inventory.archive.version-conflict] a product changed after the row was drawn: 409 version_conflict keeps the dialog open, says "changed since you opened it", offers a Load latest action that works, nothing is archived', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.archive.version-conflict' });
    const { member, shopId, productIds, token } = await ownerWithShop(page, [{ title: 'Moved Mug' }]);
    const id = productIds[0];
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await openRowAction(page, 'Moved Mug', 'Archive');
    expect((await sellerCall('PATCH', `/api/shops/${shopId}/products/${id}`, { expectedVersion: 1, quantity: 99 }, token)).status).toBe(200);
    await dialogOf(page).getByRole('button', { name: 'Archive product' }).click();
    await expect(dialogOf(page).getByText('This product changed since you opened it.')).toBeVisible();
    expect(archivePosts(api).map((entry) => entry.status)).toEqual([409]);
    expect(await productRow(id)).toMatchObject({ status: 'ACTIVE', version: 2 });
    expect(await historyOf(id)).toEqual([]);
    // the way out the message promises: "Load latest"
    await expect(dialogOf(page).getByRole('button', { name: 'Load latest' })).toBeVisible();
    await dialogOf(page).getByRole('button', { name: 'Load latest' }).click();
    await dialogOf(page).getByRole('button', { name: 'Archive product' }).click();
    await expect(page.getByText('Product archived')).toBeVisible();
    expect(await productRow(id)).toMatchObject({ status: 'ARCHIVED', version: 3 });
  });

  test('[inventory.archive.stale] a product archived elsewhere: the dialog closes and the page alert says it was archived or restored elsewhere; the list refetches', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.archive.stale' });
    const { member, shopId, productIds, token } = await ownerWithShop(page, [{ title: 'Twice Mug' }]);
    const id = productIds[0];
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await openRowAction(page, 'Twice Mug', 'Archive');
    await archiveByApi(token, shopId, id);
    await dialogOf(page).getByRole('button', { name: 'Archive product' }).click();
    await expect(page.getByText('This product was archived or restored elsewhere. The list has been refreshed.')).toBeVisible();
    await expect(dialogOf(page)).toHaveCount(0);
    expect(archivePosts(api).map((entry) => entry.status)).toEqual([409]);
    await expect.poll(() => api.count('GET', /\/products(\?|$)/)).toBeGreaterThanOrEqual(1);
    expect(await productRow(id)).toMatchObject({ status: 'ARCHIVED', version: 2 });
    expect(await historyOf(id)).toHaveLength(1);
  });

  test('[inventory.archive.extra-1, inventory.rules.invalidate-after-write] from a search row (version read fresh) a product archived elsewhere is answered 409 and explained by the page alert', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.archive.extra-1,inventory.rules.invalidate-after-write' });
    test.setTimeout(150_000);
    const { member, shopId, productIds, token } = await ownerWithShop(page, [{ title: 'Topaz Mug' }]);
    const id = productIds[0];
    await expect.poll(async () => (await indexRow(id))?.status, { timeout: 90_000 }).toBe('ACTIVE');
    await openInventory(page, member, shopId, '?q=Topaz');
    await expect(page.getByRole('row', { name: /Topaz Mug/ })).toBeVisible();
    const api = watchApi(page);
    await openRowAction(page, 'Topaz Mug', 'Archive');
    await archiveByApi(token, shopId, id);
    await dialogOf(page).getByRole('button', { name: 'Archive product' }).click();
    await expect(page.getByText('This product was archived or restored elsewhere. The list has been refreshed.')).toBeVisible();
    await expect(dialogOf(page)).toHaveCount(0);
    expect(api.count('GET', new RegExp(`/products/${id}$`))).toBe(1);
    expect(archivePosts(api).map((entry) => entry.status)).toEqual([409]);
    // the section is refetched even though the write was refused
    await expect.poll(() => api.count('GET', /\/products\/search(\?|$)/)).toBeGreaterThanOrEqual(1);
  });

  test('[inventory.archive.other-errors] 403, 429 and 500 stay inside the dialog; a later try works', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.archive.other-errors' });
    const { member, shopId, productIds } = await ownerWithShop(page, [{ title: 'Retry Mug' }]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    const stub = (status: number, code: string, headers: Record<string, string> = {}) =>
      page.route(archiveUrl, (route) => route.fulfill({ status, contentType: 'application/problem+json', headers, body: JSON.stringify({ type: 'x', title: 'No', status, code }) }));
    await openRowAction(page, 'Retry Mug', 'Archive');
    const dialog = dialogOf(page);
    const press = () => dialog.getByRole('button', { name: 'Archive product' }).click();
    await stub(403, 'permission_denied');
    await press();
    await expect(dialog.getByRole('alert')).toContainText("You don't have permission to do that.");
    await expect(dialog).toBeVisible();
    await page.unroute(archiveUrl);
    await stub(429, 'rate_limited', { 'Retry-After': '30' });
    await press();
    await expect(dialog.getByText(/^Too many requests\. Try again in \d+ s\.$/)).toBeVisible();
    await page.unroute(archiveUrl);
    await stub(500, 'internal_error');
    await press();
    await expect(dialog.getByText('Something went wrong on our side.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Archive product' })).toBeEnabled();
    await page.unroute(archiveUrl);
    expect(await productRow(productIds[0])).toMatchObject({ status: 'ACTIVE', version: 1 });
    await press();
    await expect(page.getByText('Product archived')).toBeVisible();
    expect(archivePosts(api).map((entry) => entry.status)).toEqual([403, 429, 500, 200]); // three stubbed refusals, then the real one
  });

  test('[inventory.archive.extra-2] Restore after Archive: expectedVersion from the row, history ACTIVE-ARCHIVED then ARCHIVED-ACTIVE, one event each', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.archive.extra-2' });
    const { member, shopId, productIds } = await proOwner(page).then(async (owner) => ({ ...owner, productIds: await seedAll(owner.member, owner.shopId, [{ title: 'Round Mug' }, { title: 'Other Mug' }]) }));
    const id = productIds[0];
    await openInventory(page, member, shopId);
    await openRowAction(page, 'Round Mug', 'Archive');
    await dialogOf(page).getByRole('button', { name: 'Archive product' }).click();
    await expect(page.getByText('Product archived')).toBeVisible();
    await openInventory(page, member, shopId, '?status=ARCHIVED');
    const api = watchApi(page);
    const sent: string[] = [];
    page.on('request', (request) => {
      if (/\/restore$/.test(new URL(request.url()).pathname)) sent.push(request.postData() ?? '');
    });
    await openRowAction(page, 'Round Mug', 'Restore');
    await expect(page.getByText('Product restored')).toBeVisible();
    expect(sent.map((body) => JSON.parse(body))).toEqual([{ expectedVersion: 2 }]);
    expect(api.count('POST', /\/restore$/)).toBe(1);
    expect(await productRow(id)).toMatchObject({ status: 'ACTIVE', version: 3 });
    expect((await historyOf(id)).map((h) => [h.fromStatus, h.toStatus, h.productVersion])).toEqual([['ACTIVE', 'ARCHIVED', 2], ['ARCHIVED', 'ACTIVE', 3]]);
    expect((await outboxOf(id)).map((e) => [e.eventName, e.aggregateVersion])).toEqual([['catalog.product_created', 1], ['catalog.product_archived', 2], ['catalog.product_restored', 3]]);
  });
});
