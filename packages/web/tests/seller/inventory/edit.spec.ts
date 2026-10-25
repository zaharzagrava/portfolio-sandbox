import { expect, test, type Page } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { archiveByApi, ownerWithShop, watchApi } from '../cross-cutting/support';
import { openInventory, sql } from './support';
import { indexRow, menuButton, openRowAction, outboxOf, productRow } from './write-support';

/**
 * AI QA map `inventory`, section "Edit dialog": opening, the form values, the changed-only save and what it writes, the field
 * rules, a version conflict with "Load latest", a product archived elsewhere, Cancel and Escape, a double press, the
 * Stock field, and an edit opened from a search row. Each test has a shop of its own.
 */

const editDialog = (page: Page) => page.getByRole('dialog', { name: 'Edit product' });
const field = (page: Page, label: string) => editDialog(page).getByLabel(label, { exact: true });
const save = (page: Page) => editDialog(page).getByRole('button', { name: 'Save changes' });
const patchesOf = (api: ReturnType<typeof watchApi>) => api.matching('PATCH', /\/products\/[0-9a-f-]{36}$/);
const productUrl = /\/api\/shops\/[0-9a-f-]{36}\/products\/[0-9a-f-]{36}$/;

async function openEdit(page: Page, title: string) {
  await openRowAction(page, title, 'Edit');
  await expect(editDialog(page)).toBeVisible();
  await expect(field(page, 'Title')).toBeVisible();
}

async function seedOne(page: Page, extra: { title?: string; quantity?: number; priceMinor?: number } = {}) {
  const title = extra.title ?? 'Edit Mug';
  const owner = await ownerWithShop(page, [{ title, quantity: extra.quantity ?? 10, priceMinor: extra.priceMinor ?? 2450 }]);
  return { ...owner, id: owner.productIds[0], title };
}

test.describe('Edit product dialog', () => {
  test('[inventory.edit.dialog-open, inventory.edit.price-roundtrip, inventory.edit.currency-readonly, inventory.edit.tags-not-editable] a skeleton until the read answers, then the filled form with focus on Title; 24.50 and 0.05 round-trip; no currency or tags control', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.edit.dialog-open,inventory.edit.price-roundtrip,inventory.edit.currency-readonly,inventory.edit.tags-not-editable' });
    const { member, shopId, id } = await seedOne(page);
    await sql(`UPDATE "Product" SET tags = '["alpha","beta"]'::jsonb, description = 'Plain words' WHERE id = $1`, [id]);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(productUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await gate;
      return route.continue();
    });
    await openRowAction(page, 'Edit Mug', 'Edit');
    await expect(editDialog(page)).toBeVisible();
    await expect(editDialog(page).getByText('Only the fields you change are saved.')).toBeVisible();
    await expect(editDialog(page).locator('[data-skeleton="product-form"]')).toBeVisible();
    await expect(field(page, 'Title')).toHaveCount(0);
    release();
    await expect(field(page, 'Title')).toHaveValue('Edit Mug');
    await expect(field(page, 'Title')).toBeFocused();
    await expect(field(page, 'Brand')).toHaveValue('Test');
    await expect(field(page, 'Category')).toHaveValue(/^seeded-/);
    await expect(field(page, 'Description (optional)')).toHaveValue('Plain words');
    await expect(field(page, 'Price (EUR)')).toHaveValue('24.50');
    await expect(field(page, 'Stock')).toHaveValue('10');
    await expect(save(page)).toBeDisabled();
    expect(api.count('GET', new RegExp(`/products/${id}$`))).toBe(1);
    // no control for currency or tags
    await expect(editDialog(page).getByLabel(/currency|tags/i)).toHaveCount(0);
    expect(await editDialog(page).locator('input, textarea, select').count()).toBe(6);
    // Escape closes without a write
    await page.keyboard.press('Escape');
    await expect(editDialog(page)).toHaveCount(0);
    expect(api.writes()).toHaveLength(0);
    await page.unroute(productUrl);
    // 5 minor units load as 0.05, and saving another field leaves price (and tags) alone
    await sql(`UPDATE "Product" SET "priceMinor" = 5, price = 5 WHERE id = $1`, [id]);
    await openInventory(page, member, shopId);
    await openEdit(page, 'Edit Mug');
    await expect(field(page, 'Price (EUR)')).toHaveValue('0.05');
    await field(page, 'Brand').fill('Other Brand');
    const sent = page.waitForRequest((request) => request.method() === 'PATCH');
    await save(page).click();
    expect(JSON.parse((await sent).postData() ?? '{}')).toEqual({ expectedVersion: 1, brand: 'Other Brand' });
    await expect(page.getByText('Product updated')).toBeVisible();
    const row = await productRow(id);
    expect([Number(row.priceMinor), row.tags, row.currency]).toEqual([5, ['alpha', 'beta'], 'EUR']);
  });

  test('[inventory.edit.cancel-escape] Cancel and Escape close the dialog without a write; focus returns to the row menu button', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.edit.cancel-escape' });
    const { member, shopId, id } = await seedOne(page);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await openEdit(page, 'Edit Mug');
    await field(page, 'Title').fill('Typed, not saved');
    await editDialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(editDialog(page)).toHaveCount(0);
    await expect(menuButton(page, 'Edit Mug')).toBeFocused();
    await openEdit(page, 'Edit Mug');
    await page.keyboard.press('Escape');
    await expect(editDialog(page)).toHaveCount(0);
    await expect(menuButton(page, 'Edit Mug')).toBeFocused();
    expect(api.writes()).toHaveLength(0);
    expect((await productRow(id)).version).toBe(1);
  });

  test('[inventory.edit.load-error] a failed read shows the problem with Try again; a 404 reads "This product no longer exists."', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.edit.load-error' });
    const { member, shopId } = await seedOne(page);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    let mode: 500 | 404 | 0 = 500;
    await page.route(productUrl, (route) => {
      if (route.request().method() !== 'GET' || mode === 0) return route.continue();
      const code = mode === 500 ? 'internal_error' : 'product_not_found';
      return route.fulfill({ status: mode, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'No', status: mode, code }) });
    });
    await openRowAction(page, 'Edit Mug', 'Edit');
    await expect(editDialog(page).getByRole('alert')).toBeVisible();
    await expect(field(page, 'Title')).toHaveCount(0);
    await expect(editDialog(page).getByText('Something went wrong on our side.')).toBeVisible();
    mode = 404;
    await editDialog(page).getByRole('button', { name: 'Try again' }).click();
    await expect(editDialog(page).getByText('This product no longer exists.')).toBeVisible();
    mode = 0;
    await editDialog(page).getByRole('button', { name: 'Try again' }).click();
    await expect(field(page, 'Title')).toHaveValue('Edit Mug');
    expect(api.count('GET', productUrl)).toBeGreaterThanOrEqual(3);
  });

  test('[inventory.edit.save-disabled-unchanged, inventory.edit.save-changed-only, inventory.edit.price-legacy-column, inventory.rules.outbox-event-per-write, inventory.rules.cache-invalidation, inventory.rules.search-index-follows, inventory.rules.version-sent] Save is off until a field differs; only changed fields and expectedVersion go; version+1, one outbox event with the changed fields, price columns equal, public page and search index follow', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.edit.save-disabled-unchanged,inventory.edit.save-changed-only,inventory.edit.price-legacy-column,inventory.rules.outbox-event-per-write,inventory.rules.cache-invalidation,inventory.rules.search-index-follows,inventory.rules.version-sent' });
    test.setTimeout(150_000);
    const { member, shopId, id } = await seedOne(page);
    await openInventory(page, member, shopId);
    await sellerCall('GET', `/api/products/${id}`); // warms the public cache
    await openEdit(page, 'Edit Mug');
    const api = watchApi(page);
    await expect(save(page)).toBeDisabled();
    await field(page, 'Title').fill('  Edit Mug  '); // only spaces around: still unchanged
    await expect(save(page)).toBeDisabled();
    await field(page, 'Title').fill('Edit Mug 2');
    await expect(save(page)).toBeEnabled();
    await field(page, 'Title').fill('Edit Mug');
    await expect(save(page)).toBeDisabled();
    await field(page, 'Title').fill('Edit Mug 2');
    await field(page, 'Price (EUR)').fill('30.10');
    await field(page, 'Description (optional)').fill('  A new description  ');
    const sent = page.waitForRequest((request) => request.method() === 'PATCH');
    await save(page).click();
    const request = await sent;
    expect(JSON.parse(request.postData() ?? '{}')).toEqual({ expectedVersion: 1, title: 'Edit Mug 2', description: 'A new description', priceMinor: 3010 });
    await expect(page.getByText('Product updated')).toBeVisible();
    await expect(editDialog(page)).toHaveCount(0);
    expect(patchesOf(api).map((entry) => entry.status)).toEqual([200]);
    const row = await productRow(id);
    expect([row.title, row.description, Number(row.priceMinor), Number(row.price), row.version, row.quantity]).toEqual(['Edit Mug 2', 'A new description', 3010, 3010, 2, 10]);
    await expect(page.getByRole('row', { name: /Edit Mug 2/ })).toContainText('30.10');
    const events = (await outboxOf(id)).filter((event) => event.eventName === 'catalog.product_updated');
    expect(events).toHaveLength(1);
    expect(events[0].topic).toBe('products.events');
    expect(events[0].aggregateVersion).toBe(2);
    expect([...(events[0].changedFields ?? [])].sort()).toEqual(['description', 'priceMinor', 'title']);
    // the public page shows the new values at once; the seller search index catches up
    const publicPage = await sellerCall('GET', `/api/products/${id}`);
    expect([publicPage.status, publicPage.data.title], JSON.stringify(publicPage.data).slice(0, 200)).toEqual([200, 'Edit Mug 2']);
    await expect.poll(async () => (await indexRow(id))?.title, { timeout: 90_000 }).toBe('Edit Mug 2');
    expect(Number((await indexRow(id)).priceMinor)).toBe(3010);
  });

  test('[inventory.edit.fields-rules, inventory.edit.server-validation] the same rules and messages as Add product, a zero-decimal currency shows its own label and rule; server field errors say "Check this field."', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.edit.fields-rules,inventory.edit.server-validation' });
    const { member, shopId, id } = await seedOne(page);
    await sql(`UPDATE "Product" SET currency = 'JPY' WHERE id = $1`, [id]);
    await openInventory(page, member, shopId);
    await openEdit(page, 'Edit Mug');
    const api = watchApi(page);
    await expect(field(page, 'Price (JPY)')).toHaveValue('2450');
    await field(page, 'Title').fill('   ');
    await field(page, 'Brand').fill('');
    await field(page, 'Category').fill('c'.repeat(101));
    await field(page, 'Description (optional)').fill('d'.repeat(4001));
    await field(page, 'Price (JPY)').fill('12.5');
    await field(page, 'Stock').fill('-3');
    await save(page).click();
    const dialog = editDialog(page);
    for (const message of ['Enter a title.', 'Enter a brand.', 'Use at most 100 characters.', 'Use at most 4000 characters.', 'Use a whole number.', 'Enter a whole number, 0 or more.']) {
      await expect(dialog.getByText(message).first(), message).toBeVisible();
    }
    await expect(dialog.getByText('Fix the highlighted fields.')).toBeVisible();
    await expect(field(page, 'Title')).toHaveAttribute('aria-invalid', 'true');
    await expect(field(page, 'Title')).toBeFocused();
    expect(patchesOf(api)).toHaveLength(0);
    await field(page, 'Price (JPY)').fill('abc');
    await expect(dialog.getByText('Enter a whole number.').first()).toBeVisible();
    await field(page, 'Price (JPY)').fill('0');
    await expect(dialog.getByText('A price must be more than zero.').first()).toBeVisible();
    // server-side validation errors land under the matching fields
    await field(page, 'Title').fill('Fine Title');
    await field(page, 'Brand').fill('Fine Brand');
    await field(page, 'Category').fill('fine');
    await field(page, 'Description (optional)').fill('fine');
    await field(page, 'Price (JPY)').fill('500');
    await field(page, 'Stock').fill('3');
    await page.route(productUrl, (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 400, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'Bad', status: 400, code: 'validation_failed', errors: [{ field: 'priceMinor', code: 'too_big' }, { field: 'quantity', code: 'x' }] }) })
        : route.continue(),
    );
    await save(page).click();
    await expect(dialog.getByText('Check this field.')).toHaveCount(4); // two under the fields, two in the summary list
    await expect(field(page, 'Price (JPY)')).toHaveAttribute('aria-invalid', 'true');
    await expect(field(page, 'Stock')).toHaveAttribute('aria-invalid', 'true');
    await expect(field(page, 'Price (JPY)')).toBeFocused();
    expect((await productRow(id)).version).toBe(1);
  });

  test('[inventory.edit.stock-via-form, inventory.edit.double-press] the Stock field changes quantity in the same PATCH and bumps the version once; two quick presses send one request', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.edit.stock-via-form,inventory.edit.double-press' });
    const { member, shopId, id } = await seedOne(page);
    await openInventory(page, member, shopId);
    await openEdit(page, 'Edit Mug');
    const api = watchApi(page);
    await page.route(productUrl, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return route.continue();
    });
    await field(page, 'Stock').fill('3');
    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH') sent.push(request.postData() ?? '');
    });
    await save(page).dblclick();
    await expect(page.getByText('Product updated')).toBeVisible();
    expect(patchesOf(api).map((entry) => entry.status)).toEqual([200]);
    expect(sent.map((body) => JSON.parse(body))).toEqual([{ expectedVersion: 1, quantity: 3 }]);
    const row = await productRow(id);
    expect([row.quantity, row.version]).toEqual([3, 2]);
    await expect(page.getByRole('row', { name: /Edit Mug/ })).toContainText('Low stock');
  });

  test('[inventory.edit.version-conflict, inventory.edit.load-latest] a save after someone else saved shows "changed since you opened it" with Load latest; nothing is overwritten; Load latest swaps the values and the next save works', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.edit.version-conflict,inventory.edit.load-latest' });
    const { member, shopId, id, token } = await seedOne(page);
    await openInventory(page, member, shopId);
    await openEdit(page, 'Edit Mug');
    const api = watchApi(page);
    await field(page, 'Title').fill('Mine');
    await field(page, 'Stock').fill('1');
    expect((await sellerCall('PATCH', `/api/shops/${shopId}/products/${id}`, { expectedVersion: 1, title: 'Theirs', priceMinor: 999 }, token)).status).toBe(200);
    await save(page).click();
    const dialog = editDialog(page);
    await expect(dialog.getByText('This product changed since you opened it.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Load latest' })).toBeVisible();
    expect(patchesOf(api).map((entry) => entry.status)).toEqual([409]);
    let row = await productRow(id);
    expect([row.title, row.quantity, row.version, Number(row.priceMinor)], 'the other writer wins, nothing overwritten').toEqual(['Theirs', 10, 2, 999]);
    expect((await outboxOf(id)).filter((event) => event.eventName === 'catalog.product_updated')).toHaveLength(1);
    await expect(field(page, 'Title')).toHaveValue('Mine'); // the typed values stay until the person decides
    api.reset();
    await dialog.getByRole('button', { name: 'Load latest' }).click();
    await expect(dialog.getByText('Latest values loaded. Your unsaved changes were dropped.')).toBeVisible();
    await expect(field(page, 'Title')).toHaveValue('Theirs');
    await expect(field(page, 'Price (EUR)')).toHaveValue('9.99');
    await expect(field(page, 'Stock')).toHaveValue('10');
    await expect(dialog.getByText('This product changed since you opened it.')).toHaveCount(0);
    await expect(save(page)).toBeDisabled();
    expect(api.count('GET', new RegExp(`/products/${id}$`))).toBe(1);
    await field(page, 'Stock').fill('2');
    const sent = page.waitForRequest((request) => request.method() === 'PATCH');
    await save(page).click();
    expect(JSON.parse((await sent).postData() ?? '{}')).toEqual({ expectedVersion: 2, quantity: 2 });
    await expect(page.getByText('Product updated')).toBeVisible();
    row = await productRow(id);
    expect([row.title, row.quantity, row.version]).toEqual(['Theirs', 2, 3]);
  });

  test('[inventory.edit.archived-meanwhile] a product archived elsewhere: saving says it was archived or restored elsewhere and the list is refreshed', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.edit.archived-meanwhile' });
    const { member, shopId, id, token } = await seedOne(page);
    await openInventory(page, member, shopId);
    await openEdit(page, 'Edit Mug');
    await field(page, 'Title').fill('Too Late');
    await archiveByApi(token, shopId, id);
    const api = watchApi(page);
    await save(page).click();
    await expect(page.getByText('This product was archived or restored elsewhere. The list has been refreshed.').first()).toBeVisible();
    expect(patchesOf(api).map((entry) => entry.status)).toEqual([409]);
    await expect.poll(() => api.count('GET', /\/products(\?|$)/)).toBeGreaterThanOrEqual(1);
    const row = await productRow(id);
    expect([row.title, row.status, row.version]).toEqual(['Edit Mug', 'ARCHIVED', 2]);
  });

  test('[inventory.edit.extra-1] after Load latest the archived product refuses the save with the stale text (409 product_archived)', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.edit.extra-1' });
    const { member, shopId, id, token } = await seedOne(page);
    await openInventory(page, member, shopId);
    await openEdit(page, 'Edit Mug');
    await field(page, 'Title').fill('Too Late');
    await archiveByApi(token, shopId, id);
    await save(page).click();
    await editDialog(page).getByRole('button', { name: 'Load latest' }).click();
    await field(page, 'Title').fill('Still Too Late');
    const api = watchApi(page);
    await save(page).click();
    await expect(editDialog(page).getByText('This product was archived or restored elsewhere. The list has been refreshed.')).toBeVisible();
    expect(patchesOf(api).map((entry) => entry.status)).toEqual([409]);
    expect((await productRow(id)).title).toBe('Edit Mug');
    await expect.poll(() => api.count('GET', /\/products(\?|$)/), 'the list is refetched after the refused write').toBeGreaterThanOrEqual(1);
  });

  test('[inventory.edit.open-from-search] an edit opened from a search row uses the version of the fresh read', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.edit.open-from-search' });
    test.setTimeout(150_000);
    const { member, shopId, id, token } = await seedOne(page, { title: 'Opal Mug' });
    await expect.poll(async () => (await indexRow(id))?.quantity, { timeout: 90_000 }).toBe(10);
    await openInventory(page, member, shopId, '?q=Opal');
    await expect(page.getByRole('row', { name: /Opal Mug/ })).toBeVisible();
    expect((await sellerCall('PATCH', `/api/shops/${shopId}/products/${id}`, { expectedVersion: 1, quantity: 7 }, token)).status).toBe(200);
    const api = watchApi(page);
    await openEdit(page, 'Opal Mug');
    await expect(field(page, 'Stock')).toHaveValue('7');
    await field(page, 'Brand').fill('Searched');
    const sent = page.waitForRequest((request) => request.method() === 'PATCH');
    await save(page).click();
    expect(JSON.parse((await sent).postData() ?? '{}')).toEqual({ expectedVersion: 2, brand: 'Searched' });
    await expect(page.getByText('Product updated')).toBeVisible();
    expect(api.count('GET', new RegExp(`/products/${id}$`))).toBe(1);
    expect((await productRow(id)).version).toBe(3);
  });
});
