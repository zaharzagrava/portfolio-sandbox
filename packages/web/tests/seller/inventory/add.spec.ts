import { expect, test, type Page } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { devMailboxLists, joinShopAs, ownerWithShop, setSuspended, tokenOf, watchApi, type Member } from '../cross-cutting/support';
import { openInventory, proOwner, seedAll, sql } from './support';

/**
 * AI QA map `inventory`, section "add": the Add product button, the dialog (focus, keyboard, cancel), every field and its errors,
 * the money and stock rules, the create call (one request, headers, body), the stored row and its outbox event, the refusals
 * (plan limit, rate limit, suspended and closing shop, roles) and odd text. Each test uses a shop of its own.
 */

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Add product' });
const field = (page: Page, label: string) => dialog(page).getByLabel(label, { exact: true });
const createButton = (page: Page) => dialog(page).getByRole('button', { name: /^(Create product|Creating…)$/ });
const rowsOf = (page: Page) => page.locator('tbody tr');
const addButton = (page: Page) => page.getByRole('button', { name: 'Add product' }).first();
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 640;

type Values = { title: string; brand: string; category: string; description: string; price: string; stock: string };
const VALID: Values = { title: 'Walnut spoon', brand: 'Woodworks', category: 'Kitchen', description: '', price: '24.50', stock: '5' };
let counter = 0;
const unique = (base: string) => `${base} ${Date.now().toString(36)}${counter++}`;

async function openAdd(page: Page) {
  await addButton(page).click();
  await expect(dialog(page)).toBeVisible();
}
async function fillForm(page: Page, values: Partial<Values>) {
  const all = { ...VALID, title: unique('Spoon'), ...values };
  await field(page, 'Title').fill(all.title);
  await field(page, 'Brand').fill(all.brand);
  await field(page, 'Category').fill(all.category);
  await field(page, 'Description (optional)').fill(all.description);
  await field(page, 'Price (EUR)').fill(all.price);
  await field(page, 'Stock').fill(all.stock);
  return all;
}
const isCreate = (request: { method(): string; url(): string }) => request.method() === 'POST' && /\/api\/shops\/[^/]+\/products$/.test(new URL(request.url()).pathname);
/** Presses Create and returns the JSON body the page sent. */
async function createAndCapture(page: Page): Promise<Record<string, unknown>> {
  const sent = page.waitForRequest(isCreate, { timeout: 15_000 });
  await createButton(page).click();
  return (await sent).postDataJSON();
}
const productRow = async (shopId: string, title: string) =>
  (await sql<Record<string, unknown>>(`SELECT * FROM "Product" WHERE "shopId" = $1 AND title = $2`, [shopId, title]))[0];

test.describe('Add product: button and dialog', () => {
  test('[inventory.add.button, inventory.add.dialog-open, inventory.add.dialog-keyboard, inventory.add.cancel] the button opens a dialog with focus on Title; Tab stays inside; Escape closes and returns focus; Cancel sends nothing and the form reopens empty', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.button,inventory.add.dialog-open,inventory.add.dialog-keyboard,inventory.add.cancel' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await expect(addButton(page)).toBeEnabled();
    await expect(page.locator('#inventory-add-note')).toHaveCount(0);
    await openAdd(page);
    await expect(dialog(page)).toHaveAccessibleDescription('Title, brand, category, price and stock are required.');
    await expect(field(page, 'Title')).toBeFocused();
    await expect(field(page, 'Stock')).toHaveValue('0');
    if (isPhone(page)) {
      const viewport = page.viewportSize() as { width: number; height: number };
      // the dialog zooms in; once it has settled it fills the screen
      await expect.poll(async () => (await dialog(page).boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(viewport.width - 1);
      await expect.poll(async () => (await dialog(page).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(viewport.height - 1);
    }
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(addButton(page)).toBeFocused();

    await openAdd(page);
    await field(page, 'Title').fill('Draft text');
    await field(page, 'Stock').fill('9');
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await openAdd(page);
    for (const label of ['Title', 'Brand', 'Category', 'Description (optional)', 'Price (EUR)']) await expect(field(page, label)).toHaveValue('');
    await expect(field(page, 'Stock')).toHaveValue('0');
    expect(api.writes()).toEqual([]);
    expect(Number((await sql(`SELECT count(*)::int AS n FROM "Product" WHERE "shopId" = $1`, [shopId]))[0].n)).toBe(0);
  });
});

test.describe('Add product: fields', () => {
  test('[inventory.add.invalid-submit, inventory.add.field-title, inventory.add.field-brand, inventory.add.field-category, inventory.add.field-description, inventory.add.leading-trailing-spaces] text fields: required, trimmed, limits, the alert, aria-invalid and focus on the first bad field', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.invalid-submit,inventory.add.field-title,inventory.add.field-brand,inventory.add.field-category,inventory.add.field-description,inventory.add.leading-trailing-spaces' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await openAdd(page);
    // no error before the first press, even after typing and clearing
    await field(page, 'Title').fill('x');
    await field(page, 'Title').fill('');
    await expect(dialog(page).getByText('Enter a title.')).toHaveCount(0);

    await field(page, 'Title').fill('   '); // only spaces is empty
    await createButton(page).click();
    const alert = dialog(page).getByRole('alert');
    await expect(alert).toContainText('Fix the highlighted fields.');
    await expect(alert.getByRole('listitem')).toHaveText(['Enter a title.', 'Enter a brand.', 'Enter a category.', 'Enter a price.']);
    await expect(field(page, 'Title')).toHaveAttribute('aria-invalid', 'true');
    await expect(field(page, 'Title')).toBeFocused();
    await expect(field(page, 'Description (optional)')).not.toHaveAttribute('aria-invalid', 'true');
    // fixing the field clears its message at once
    await field(page, 'Title').fill('Fine');
    await expect(dialog(page).getByText('Enter a title.')).toHaveCount(0);

    // limits
    const long = (n: number) => 'x'.repeat(n);
    expect(await field(page, 'Title').evaluate((input) => (input as HTMLInputElement).maxLength)).toBe(250);
    await field(page, 'Title').fill(long(300));
    expect((await field(page, 'Title').inputValue()).length).toBe(250); // the box stops at 250
    await field(page, 'Brand').fill(long(101));
    await field(page, 'Category').fill(long(101));
    await field(page, 'Description (optional)').fill(long(4001));
    await field(page, 'Price (EUR)').fill('1');
    await createButton(page).click();
    await expect(alert.getByRole('listitem')).toHaveText(['Use at most 200 characters.', 'Use at most 100 characters.', 'Use at most 100 characters.', 'Use at most 4000 characters.']);
    await expect(field(page, 'Title')).toBeFocused();
    expect(api.writes()).toEqual([]);

    // the limits themselves are fine: 200 / 100 / 100 / 4000, surrounded by spaces, are trimmed before sending
    await field(page, 'Title').fill(`  ${long(200)}  `);
    await field(page, 'Brand').fill(`  ${long(100)}\t`);
    await field(page, 'Category').fill(` ${long(100)} `);
    await field(page, 'Description (optional)').fill(long(4000));
    const body = await createAndCapture(page);
    expect(body).toMatchObject({ title: long(200), brand: long(100), category: long(100), description: long(4000), priceMinor: 100, currency: 'EUR', quantity: 0 });
    await expect(dialog(page)).toHaveCount(0);
    const row = await productRow(shopId, long(200));
    expect([row.brand, row.category, String(row.description).length]).toEqual([long(100), long(100), 4000]);
  });

  test('[inventory.add.field-description] a description of exactly 4000 characters with spaces around it is accepted and saved trimmed (P2F5)', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.field-description-padded' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    await openAdd(page);
    const values = await fillForm(page, { description: `\n ${'d'.repeat(4000)} \n` });
    const body = await createAndCapture(page);
    expect(body.description).toBe('d'.repeat(4000));
    await expect(dialog(page)).toHaveCount(0);
    expect(String((await productRow(shopId, values.title)).description).length).toBe(4000);
  });

  test('[inventory.add.field-description] an empty description is not sent', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.field-description' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    await openAdd(page);
    const values = await fillForm(page, { description: '   ' });
    const body = await createAndCapture(page);
    expect(body).not.toHaveProperty('description');
    await expect(dialog(page)).toHaveCount(0);
    expect(String((await productRow(shopId, values.title)).description ?? '')).toBe('');
  });

  test('[inventory.add.field-price, inventory.add.price-errors] the price field: digits with one point or comma, the five error texts', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.field-price,inventory.add.price-errors' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await openAdd(page);
    await expect(field(page, 'Price (EUR)')).toHaveAttribute('inputmode', 'decimal');
    await fillForm(page, {});
    const cases: [string, string][] = [
      ['', 'Enter a price.'],
      ['-5', "A price can't be negative."],
      ['abc', 'Enter a price like 24.50.'],
      ['1e3', 'Enter a price like 24.50.'],
      ['1.2.3', 'Enter a price like 24.50.'],
      ['1.234', 'Use at most 2 decimal places.'],
      ['1.005', 'Use at most 2 decimal places.'],
      ['0', 'A price must be more than zero.'],
      ['0.00', 'A price must be more than zero.'],
      ['100000000.01', 'That price is too large.'],
      ['99999999999999999999', 'That price is too large.'],
    ];
    for (const [text, message] of cases) {
      await field(page, 'Price (EUR)').fill(text);
      await createButton(page).click();
      await expect(dialog(page).getByRole('alert').getByRole('listitem'), `price "${text}"`).toHaveText([message]);
      await expect(field(page, 'Price (EUR)')).toBeFocused();
    }
    expect(api.writes()).toEqual([]);
  });

  test('[inventory.add.price-edge-values, inventory.add.field-price] 24.50, 24,5, 0.01, 19.99, 99999999.99 and the maximum 100000000.00 are accepted and stored as exact minor units', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.price-edge-values,inventory.add.field-price' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    const cases: [string, number][] = [['24.50', 2450], ['24,5', 2450], ['0.01', 1], ['19.99', 1999], ['99999999.99', 9_999_999_999], ['100000000.00', 10_000_000_000], [' 7 ', 700]];
    for (const [text, minor] of cases) {
      await openAdd(page);
      const values = await fillForm(page, { price: text });
      const body = await createAndCapture(page);
      expect(body.priceMinor, `price "${text}"`).toBe(minor);
      await expect(dialog(page)).toHaveCount(0);
      const row = await productRow(shopId, values.title);
      expect(Number(row.priceMinor)).toBe(minor);
      expect(Number(row.price)).toBe(minor); // the legacy price column equals priceMinor
      const shown = (await rowsOf(page).first().innerText()).replace(/\s+/g, ' ');
      expect(shown).toContain(values.title);
      expect(shown.replace(/[^\d]/g, '')).toContain(String(minor).padStart(3, '0')); // the digits of the price, shown back exactly
    }
  });

  test('[inventory.add.field-stock, inventory.add.stock-edge-values] the stock field: 0 to 1,000,000,000 whole, spaces trimmed, the single error text', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.field-stock,inventory.add.stock-edge-values' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await openAdd(page);
    await expect(field(page, 'Stock')).toHaveAttribute('inputmode', 'numeric');
    await fillForm(page, {});
    for (const text of ['', '-1', '1.5', '1e3', 'abc', '1000000001', '01 2', '١٢']) {
      await field(page, 'Stock').fill(text);
      await createButton(page).click();
      await expect(dialog(page).getByRole('alert').getByRole('listitem'), `stock "${text}"`).toHaveText(['Enter a whole number, 0 or more.']);
      await expect(field(page, 'Stock')).toBeFocused();
    }
    expect(api.writes()).toEqual([]);
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    for (const [text, quantity] of [['0', 0], ['1', 1], ['1000000000', 1_000_000_000], [' 12 ', 12]] as [string, number][]) {
      await openAdd(page);
      const values = await fillForm(page, { stock: text });
      const body = await createAndCapture(page);
      expect(body.quantity).toBe(quantity);
      await expect(dialog(page)).toHaveCount(0);
      expect(Number((await productRow(shopId, values.title)).quantity)).toBe(quantity);
    }
  });

  test('[inventory.add.unicode-emoji-html] emoji, accents, 200 emoji (code points) and script text are saved and shown as text; 201 emoji are refused', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.unicode-emoji-html' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    const emoji200 = '😀'.repeat(120); // 240 UTF-16 units: fits the box
    const texts = [emoji200, `<script>alert(1)</script> ${Date.now()}`, `Crème brûlée ☕ ${Date.now()}`, `'; DROP TABLE "Product"; -- ${Date.now()}`];
    for (const title of texts) {
      await openAdd(page);
      await fillForm(page, { title, brand: 'Ünï <b>x</b>', category: '日本語' });
      await createAndCapture(page);
      await expect(dialog(page)).toHaveCount(0);
      const row = await productRow(shopId, title);
      expect([row.title, row.brand, row.category]).toEqual([title, 'Ünï <b>x</b>', '日本語']);
      await expect(page.getByRole('rowheader', { name: title })).toBeVisible();
    }
    expect(await page.locator('b', { hasText: 'x' }).count()).toBe(0); // shown as text, never as markup
    await openAdd(page);
    await fillForm(page, { title: '😀'.repeat(125) + 'a'.repeat(76) }); // 201 code points, 326 units: the box cuts at 250 units, so test the count with letters
    await field(page, 'Title').fill('a'.repeat(201));
    await createButton(page).click();
    await expect(dialog(page).getByRole('alert').getByRole('listitem')).toHaveText(['Use at most 200 characters.']);
  });
});

test.describe('Add product: creating', () => {
  test('[inventory.add.unicode-emoji-html] a title of 200 emoji (200 code points) is saved whole, not cut at 125 (P2F4)', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.unicode-emoji-html-200' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    await openAdd(page);
    await fillForm(page, { title: '😀'.repeat(200) });
    const body = await createAndCapture(page);
    expect([...String(body.title)].length).toBe(200);
  });

  test('[inventory.add.create-button, inventory.add.create-db-row, inventory.add.double-press, inventory.add.enter-key, inventory.add.fields-readonly-while-saving, inventory.add.idempotency-key, inventory.add.csrf-header] one request for a double press and Enter, read-only fields while it runs, the row, its history and its outbox event', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.create-button,inventory.add.create-db-row,inventory.add.double-press,inventory.add.enter-key,inventory.add.fields-readonly-while-saving,inventory.add.idempotency-key,inventory.add.csrf-header' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    const requests: { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    page.on('request', (request) => {
      if (isCreate(request)) requests.push({ method: request.method(), url: request.url(), headers: request.headers(), body: request.postDataJSON() });
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route((url) => /\/api\/shops\/[^/]+\/products$/.test(url.pathname), async (route) => {
      if (route.request().method() === 'POST') await gate;
      await route.continue();
    });
    await openAdd(page);
    const values = await fillForm(page, { description: '  A fine spoon  ', price: '24,5', stock: '7' });
    await createButton(page).dblclick(); // two quick presses
    await expect(createButton(page)).toHaveText('Creating…');
    await expect(createButton(page)).toBeDisabled();
    await expect(createButton(page)).toHaveAttribute('aria-busy', 'true');
    await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    for (const label of ['Title', 'Brand', 'Category', 'Description (optional)', 'Price (EUR)', 'Stock']) await expect(field(page, label)).toHaveAttribute('readonly', '');
    await field(page, 'Title').press('Enter'); // a third try, from the keyboard, while it runs
    release();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText('Product created')).toBeVisible();
    await expect(rowsOf(page).first()).toContainText(values.title);
    await expect(rowsOf(page).first()).toContainText('In stock');
    expect(requests.length).toBe(1);
    expect(api.count('POST', /\/products$/)).toBe(1);
    const sent = requests[0];
    expect(new URL(sent.url).origin).toBe(new URL(page.url()).origin); // a relative path
    expect(sent.headers['x-csrf-token'], 'CSRF header').toBeTruthy();
    expect(sent.headers['authorization']).toBeUndefined();
    expect(sent.headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); // one key per create attempt (B-034)
    expect(sent.body).toEqual({ title: values.title, brand: 'Woodworks', category: 'Kitchen', description: 'A fine spoon', priceMinor: 2450, currency: 'EUR', quantity: 7 });

    const rows = await sql<Record<string, unknown>>(`SELECT * FROM "Product" WHERE "shopId" = $1 AND title = $2`, [shopId, values.title]);
    expect(rows.length).toBe(1);
    const row = rows[0];
    const owner = (await sql<{ id: string }>(`SELECT id FROM "User" WHERE email = $1`, [member.email]))[0].id;
    const shop = { isSandbox: (await sql<{ sandboxOf: string | null }>(`SELECT "sandboxOf" FROM "Shop" WHERE id = $1`, [shopId]))[0].sandboxOf !== null };
    expect({ ...row, priceMinor: Number(row.priceMinor) }).toMatchObject({ shopId, createdBy: owner, currency: 'EUR', priceMinor: 2450, quantity: 7, tags: [], status: 'ACTIVE', version: 1, isSandbox: shop.isSandbox, description: 'A fine spoon' });
    expect(Number(row.price)).toBe(2450);
    const events = await sql<{ eventName: string; topic: string; payload: unknown }>(`SELECT "eventName", topic, payload FROM "Outbox" WHERE "aggregateId" = $1`, [row.id]);
    expect(events.map((event) => `${event.eventName}@${event.topic}`).sort(), JSON.stringify(events)).toContain('catalog.product_created@products.events');
    const history = await sql(`SELECT "fromStatus", "toStatus", "productVersion" FROM "ProductStatusHistory" WHERE "productId" = $1`, [row.id]);
    test.info().annotations.push({ type: 'history-rows', description: JSON.stringify(history) });
  });

  test('[inventory.add.enter-key] Enter in a field submits like the button', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.enter-key' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    await openAdd(page);
    const values = await fillForm(page, {});
    const sent = page.waitForRequest(isCreate);
    await field(page, 'Brand').press('Enter');
    expect((await sent).postDataJSON().title).toBe(values.title);
    await expect(dialog(page)).toHaveCount(0);
  });

  test('[inventory.add.server-validation] a validation_failed answer shows "Check this field." under the named fields, focuses the first, and typing clears the message', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.server-validation' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    await page.route((url) => /\/api\/shops\/[^/]+\/products$/.test(url.pathname), async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ status: 400, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'Bad', status: 400, code: 'validation_failed', errors: [{ field: 'quantity', code: 'x' }, { field: 'priceMinor', code: 'y' }, { field: 'currency', code: 'z' }, { field: 'brand', code: 'w' }] }) });
    });
    await openAdd(page);
    await fillForm(page, {});
    await createButton(page).click();
    const messages = dialog(page).getByText('Check this field.');
    await expect(dialog(page).getByRole('alert').getByRole('listitem')).toHaveText(['Check this field.', 'Check this field.', 'Check this field.']); // brand, price (once), stock
    await expect(messages.nth(3)).toBeAttached(); // list + three field messages
    await expect(field(page, 'Brand')).toBeFocused();
    await field(page, 'Price (EUR)').fill('25');
    await expect(dialog(page).getByRole('alert').getByRole('listitem')).toHaveText(['Check this field.', 'Check this field.']);
    await expect(field(page, 'Price (EUR)')).not.toHaveAttribute('aria-invalid', 'true');
  });
});

test.describe('Add product: refusals', () => {
  test('[inventory.add.plan-limit] at the plan limit the dialog says so in words and nothing is written', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.plan-limit' });
    const { member, shopId } = await ownerWithShop(page);
    await seedAll(member, shopId, Array.from({ length: 10 }, (_, i) => ({ title: `Full ${i}` })));
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await openAdd(page);
    const values = await fillForm(page, {});
    await createButton(page).click();
    await expect.poll(() => api.matching('POST', /\/products$/).map((entry) => entry.status)).toEqual([409]);
    expect((await sql(`SELECT 1 FROM "Product" WHERE "shopId" = $1 AND title = $2`, [shopId, values.title])).length).toBe(0);
    await expect(dialog(page)).toBeVisible(); // the form stays
    await expect(field(page, 'Title')).toHaveValue(values.title);
    // a clear message: it names the plan or the limit
    await expect(dialog(page).getByRole('alert')).toContainText(/plan|limit|upgrade/i);
  });

  test('[inventory.add.rate-limit] a 429 rate_limited answer (Retry-After 30) shows a countdown in the dialog; the form values stay and nothing is created', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.rate-limit' });
    // The stack's API lets the loopback address through (RATE_LIMIT_ALLOW_IPS), so the 429 itself is stubbed; the page's reaction is what is checked.
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    await page.route((url) => /\/api\/shops\/[^/]+\/products$/.test(url.pathname), (route) =>
      route.request().method() !== 'POST'
        ? route.continue()
        : route.fulfill({ status: 429, contentType: 'application/problem+json', headers: { 'Retry-After': '30' }, body: JSON.stringify({ type: 'x', title: 'Too many', status: 429, code: 'rate_limited' }) }),
    );
    await openAdd(page);
    const values = await fillForm(page, {});
    await createButton(page).click();
    await expect(dialog(page).getByText(/^Too many requests\. Try again in (30|29|28|27) s\.$/)).toBeVisible();
    await expect(dialog(page)).toBeVisible();
    await expect(field(page, 'Title')).toHaveValue(values.title);
    await expect(field(page, 'Price (EUR)')).toHaveValue('24.50');
    expect((await sql(`SELECT 1 FROM "Product" WHERE "shopId" = $1 AND title = $2`, [shopId, values.title])).length).toBe(0);
  });

  test('[inventory.add.suspended-api] a shop suspended or closed after the page opened: Create answers 403 shop_suspended / 409 shop_offboarding, the dialog shows the shop copy, no row', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.suspended-api' });
    const { member, shopId } = await proOwner(page);
    await openInventory(page, member, shopId);
    const api = watchApi(page);
    await openAdd(page);
    const values = await fillForm(page, {});
    await setSuspended(shopId, true);
    await createButton(page).click();
    await expect.poll(() => api.matching('POST', /\/products$/).map((entry) => entry.status)).toEqual([403]);
    await expect(dialog(page).getByRole('alert')).toContainText('This shop is suspended');
    expect((await sql(`SELECT 1 FROM "Product" WHERE "shopId" = $1 AND title = $2`, [shopId, values.title])).length).toBe(0);
    await setSuspended(shopId, false);
    await sql(`UPDATE "Shop" SET status = 'DELETING' WHERE id = $1`, [shopId]);
    await createButton(page).click();
    await expect.poll(() => api.matching('POST', /\/products$/).map((entry) => entry.status)).toEqual([403, 409]);
    await expect(dialog(page).getByRole('alert')).toContainText('This shop is being closed');
    expect((await sql(`SELECT 1 FROM "Product" WHERE "shopId" = $1 AND title = $2`, [shopId, values.title])).length).toBe(0);
  });
});

test.describe('Add product: roles', () => {
  test('[inventory.add.button-viewer, inventory.add.viewer-api, inventory.menu.viewer-hidden] a VIEWER reads the list but has no Add product and no row menu; POST is 403 permission_denied for a viewer and 404 for a non-member; STAFF and ADMIN can create', async ({ page, browser }) => {
    test.skip(!(await devMailboxLists()), 'the dev mailbox is needed to invite members');
    test.setTimeout(150_000);
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.add.button-viewer,inventory.add.viewer-api,inventory.menu.viewer-hidden,inventory.add.button' });
    const { member, shopId } = await ownerWithShop(page, [{ title: 'Role Mug' }]);
    const viewer = await joinShopAs(browser, member, shopId, 'VIEWER');
    await openInventory(viewer.page, viewer.member as Member, shopId);
    await expect(viewer.page.getByRole('rowheader', { name: 'Role Mug' })).toBeVisible();
    await expect(viewer.page.getByRole('button', { name: 'Add product' })).toHaveCount(0);
    await expect(viewer.page.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
    const viewerToken = await tokenOf(viewer.member);
    const denied = await sellerCall('POST', `/api/shops/${shopId}/products`, { title: 'Nope', brand: 'b', category: 'c', priceMinor: 100, quantity: 1 }, viewerToken);
    expect([denied.status, denied.data.code]).toEqual([403, 'permission_denied']);
    expect((await sql(`SELECT 1 FROM "Product" WHERE "shopId" = $1 AND title = 'Nope'`, [shopId])).length).toBe(0);
    const outsider = await browser.newContext();
    const outsiderMember = await (await import('../../helpers')).register(await outsider.newPage());
    const notFound = await sellerCall('POST', `/api/shops/${shopId}/products`, { title: 'Nope', brand: 'b', category: 'c', priceMinor: 100, quantity: 1 }, await tokenOf(outsiderMember));
    expect(notFound.status).toBe(404);
    // an empty shop shows a viewer only the text
    await viewer.context.close();
    await outsider.close();

    for (const role of ['STAFF', 'ADMIN'] as const) {
      const joined = await joinShopAs(browser, member, shopId, role);
      await openInventory(joined.page, joined.member as Member, shopId);
      await expect(joined.page.getByRole('button', { name: 'Add product' }).first()).toBeEnabled();
      await joined.page.getByRole('button', { name: 'Add product' }).first().click();
      const open = joined.page.getByRole('dialog', { name: 'Add product' });
      await open.getByLabel('Title', { exact: true }).fill(`By ${role}`);
      await open.getByLabel('Brand', { exact: true }).fill('b');
      await open.getByLabel('Category', { exact: true }).fill('c');
      await open.getByLabel('Price (EUR)', { exact: true }).fill('3');
      await open.getByRole('button', { name: 'Create product' }).click();
      await expect(open).toHaveCount(0);
      const stored = await sql<{ createdBy: string }>(`SELECT "createdBy" FROM "Product" WHERE "shopId" = $1 AND title = $2`, [shopId, `By ${role}`]);
      const userId = (await sql<{ id: string }>(`SELECT id FROM "User" WHERE email = $1`, [joined.member.email]))[0].id;
      expect(stored[0].createdBy).toBe(userId);
      await joined.context.close();
    }
  });

  test('[inventory.empty.none] a shop with no products says "No products yet." with an Add product button for writers', async ({ page }) => {
    test.info().annotations.push({ type: 'aiqa-lines', description: 'inventory.empty.none' });
    const { member, shopId } = await ownerWithShop(page);
    await openInventory(page, member, shopId);
    const region = page.getByRole('region', { name: 'Products' });
    await expect(region.getByText('No products yet.')).toBeVisible();
    await expect(region.getByRole('button', { name: 'Add product' })).toBeEnabled();
    await region.getByRole('button', { name: 'Add product' }).click();
    await expect(dialog(page)).toBeVisible();
    expect(Number((await sql(`SELECT count(*)::int AS n FROM "Product" WHERE "shopId" = $1`, [shopId]))[0].n)).toBe(0);
  });
});
