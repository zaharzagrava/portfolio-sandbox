import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { NEW_USER_PASSWORD, register, resetRateLimits, sellerCall, shopPath } from '../helpers';
import { openShopByApi } from '../seller-setup';
import { tokenOf, type Member } from '../seller/cross-cutting/support';

/**
 * Set-up shared by the AI QA specs of the inventory page (`seller-inventory*.spec.ts`). The members and shops are the specs'
 * own; the database is read with the connection settings the seed scripts use, only to check what the page and the API claim.
 */

export type Seed = { title: string; quantity?: number; priceMinor?: number; currency?: string };

function dbClient() {
  const backend = path.resolve(__dirname, '../../../backend');
  const { Client } = createRequire(path.join(backend, 'package.json'))('pg');
  const env = Object.fromEntries(
    readFileSync(path.join(backend, '.env'), 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.split('=')[0], line.slice(line.indexOf('=') + 1)]),
  );
  return new Client({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USERNAME, password: env.DB_PASSWORD, database: env.DB_NAME });
}

/** One read or write against the real database. */
export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const db = dbClient();
  await db.connect();
  try {
    return (await db.query(text, params)).rows as T[];
  } finally {
    await db.end();
  }
}

/** Gives the shop the Pro plan (10 000 products) by copying the Pro subscription of any shop that has one. */
export async function makePro(shopId: string): Promise<void> {
  await sql(
    `INSERT INTO "Subscription" SELECT gen_random_uuid(), "subjectType", $1, "priceId", status, quantity, "billingAnchorDay", "currentPeriodStart",
            "currentPeriodEnd", "trialEndsAt", "cancelAtPeriodEnd", "paymentMethodRef", 0, now(), now(), now(), NULL, NULL, NULL, 0
       FROM "Subscription" WHERE "subjectType" = 'SHOP' AND "priceId" = (SELECT pr.id FROM "Price" pr JOIN "Plan" p ON p.id = pr."planId" WHERE p.code = 'pro' LIMIT 1) LIMIT 1`,
    [shopId],
  );
}

/** Creates the products one after the other, so their creation order (and the newest-first order of the list) is known. */
export async function seedAll(member: Member, shopId: string, products: Seed[]): Promise<string[]> {
  const token = await tokenOf(member);
  const ids: string[] = [];
  for (const product of products) {
    const created = await sellerCall('POST', `/api/shops/${shopId}/products`, { title: product.title, brand: 'Test', category: 'aiqa', priceMinor: product.priceMinor ?? 2450, quantity: product.quantity ?? 10 }, token);
    expect(created.status, `create ${product.title}: ${JSON.stringify(created.data)}`).toBe(201);
    ids.push(created.data.id as string);
    if (product.currency) await sql(`UPDATE "Product" SET currency = $1 WHERE id = $2`, [product.currency, created.data.id]);
  }
  return ids;
}

export async function archiveAll(member: Member, shopId: string, ids: string[]): Promise<void> {
  const token = await tokenOf(member);
  for (const id of ids) {
    const product = await sellerCall('GET', `/api/shops/${shopId}/products/${id}`, undefined, token);
    const archived = await sellerCall('POST', `/api/shops/${shopId}/products/${id}/archive`, { expectedVersion: product.data.version }, token);
    expect(archived.status).toBe(200);
  }
}

/** A registered member with a Pro shop, signed in on `page`. */
export async function proOwner(page: Page) {
  const member = await register(page);
  const { shopId, shopName } = await openShopByApi(member);
  await makePro(shopId);
  return { member, shopId, shopName };
}

type ProOwner = Awaited<ReturnType<typeof proOwner>>;
let sharedPro: Promise<ProOwner> | undefined;
/**
 * One member with one Pro shop per worker process, for tests that only add rows with titles of their own (they find them by title)
 * and never change the shop, the plan, the roles or the limits. The page is signed in as that member by the API.
 */
export async function sharedProOwner(page: Page): Promise<ProOwner> {
  sharedPro ??= proOwner(page);
  const owner = await sharedPro;
  await resetRateLimits();
  const session = await page.request.post('/api/bff/session', { data: { email: owner.member.email, password: owner.member.password ?? NEW_USER_PASSWORD } });
  expect(session.status(), `sign in ${owner.member.email}: ${await session.text()}`).toBeLessThan(300);
  return owner;
}

const signedIn = new WeakSet<Page>();

/** Signs an existing member in again on a page and opens the inventory of the shop with the given query. */
export async function openInventory(page: Page, member: Member, shopId: string, query = '') {
  const target = `${shopPath(shopId, 'inventory')}${query}`;
  if (!signedIn.has(page)) {
    await resetRateLimits();
    const session = await page.request.post('/api/bff/session', { data: { email: member.email, password: member.password ?? NEW_USER_PASSWORD } });
    expect(session.status(), `sign in ${member.email}: ${await session.text()}`).toBeLessThan(300);
    signedIn.add(page);
  }
  await page.goto(target);
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
}

/** The cells of every body row: name, price, stock, status text. */
export async function tableRows(page: Page): Promise<string[][]> {
  return page.locator('tbody tr').evaluateAll((rows) => rows.map((row) => [...row.children].slice(0, 4).map((cell) => (cell as HTMLElement).innerText.replace(/\s+/g, ' ').trim())));
}

/** Set-up shared by the AI QA specs of the inventory writes (edit, stock, archive, restore): rows read back from the real database. */

export const menuButton = (page: Page, title: string) => page.getByRole('button', { name: `Actions for ${title}`, exact: true });

export async function openRowAction(page: Page, title: string, item: string) {
  await menuButton(page, title).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** The product row as the database holds it. */
export async function productRow(id: string) {
  const row = (await sql<{ title: string; brand: string; category: string; description: string; priceMinor: number; price: unknown; quantity: number; version: number; status: string; currency: string; tags: unknown }>(
    `SELECT title, brand, category, description, "priceMinor", price, quantity, version, status, currency, tags FROM "Product" WHERE id = $1`,
    [id],
  ))[0];
  expect(row, `product ${id} exists`).toBeTruthy();
  return row;
}

export type OutboxRow = { topic: string; eventName: string; aggregateVersion: number; changedFields: string[] | null; status: unknown; quantity: number | null };

/** Every outbox row of a product, oldest first. */
export async function outboxOf(id: string): Promise<OutboxRow[]> {
  return sql<OutboxRow>(
    `SELECT topic, "eventName", (payload->>'aggregateVersion')::int AS "aggregateVersion", payload->'payload'->'changedFields' AS "changedFields",
            payload->'payload'->>'status' AS status, (payload->'payload'->>'quantity')::int AS quantity
       FROM "Outbox" WHERE "aggregateId" = $1 AND "aggregateType" = 'products' ORDER BY "createdAt", id`,
    [id],
  );
}

export const historyOf = (id: string) =>
  sql<{ fromStatus: string; toStatus: string; productVersion: number; actorId: string | null }>(
    `SELECT "fromStatus", "toStatus", "productVersion", "actorId" FROM "ProductStatusHistory" WHERE "productId" = $1 ORDER BY at, id`,
    [id],
  );

export const indexRow = async (id: string) =>
  (await sql<{ title: string; status: string; quantity: number; priceMinor: number }>(`SELECT title, status, quantity, "priceMinor" FROM "SearchShopProduct" WHERE "productId" = $1`, [id]))[0];

/**
 * Waits until the search index (SearchShopProduct, filled from the outbox by the poller in batches) holds `count` rows of the shop, and,
 * when `archived` is given, that product as ARCHIVED. Polls the database quickly instead of reloading a page; the bound stays at 60 s.
 */
export async function waitIndexed(shopId: string, count: number, opts: { archived?: string } = {}): Promise<void> {
  await expect
    .poll(async () => Number((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM "SearchShopProduct" WHERE "shopId" = $1`, [shopId]))[0].n), { timeout: 60_000, intervals: [100, 200, 300] })
    .toBe(count);
  if (opts.archived) {
    await expect.poll(async () => (await indexRow(opts.archived as string))?.status, { timeout: 60_000, intervals: [100, 200, 300] }).toBe('ARCHIVED');
  }
}
