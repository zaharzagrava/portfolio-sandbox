import { expect, test, type Page } from '@playwright/test';
import { NEW_USER_PASSWORD, resetRateLimits, sellerCall, shopPath, uniqueEmail } from '../../helpers';
import { openSecondShop, ownerWithShop, type Member } from '../cross-cutting/support';
import { rows, scalar, userId } from '../support/db';
import { readSlices, signIn, type Slice } from './support';
import { runSql, seedSlices } from './seed';

/**
 * AI QA, orders area (pass 2), section "database": how the list is built from ShopOrder, BisOrder and BisOrderItem, in shapes
 * the checkout cannot make (a NULL title, a slice with no shop, two shops on one order, 10 000 slices). The rows are written
 * for a shop and a buyer this spec made; the page and the API still do the reading (map: scripts/aiqa/coverage/orders.tsv).
 */

test.setTimeout(240_000);

const BASE = Date.now() - 3_600_000;
const at = (secondsAgo: number) => new Date(BASE - secondsAgo * 1000).toISOString();
const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
const rowsOf = (page: Page) => page.getByRole('region', { name: 'Orders' }).locator('tbody tr');

let owner: Member;
let token: string;
let buyerId: string;
const ordersPath = (shop: string, query = '') => `${shopPath(shop, 'orders')}${query}`;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const made = await ownerWithShop(page, []);
    owner = made.member;
    token = made.token;
    await resetRateLimits();
    const email = uniqueEmail('orders-db-buyer');
    expect((await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
    buyerId = userId(email);
  } finally {
    await context.close();
  }
});

const newShop = async () => (await openSecondShop(owner)).shopId;
const read = async (shop: string) => (await sellerCall('GET', `/api/shops/${shop}/orders?limit=100`, undefined, token)).data.items as Slice[];

test('[orders.db.join-bisorder] currency comes from BisOrder (the buyer is joined but never sent) through the join; a slice cannot exist without its BisOrder', async ({ page }) => {
  lines('orders.db.join-bisorder');
  const shop = await newShop();
  const [first, second] = seedSlices(shop, buyerId, [{ createdAt: at(1), subtotal: 12345 }, { createdAt: at(2), subtotal: 500 }]);
  runSql(`update "BisOrder" set currency='USD' where id='${first.orderId}'`);
  const items = await read(shop);
  expect(items.map((item) => [item.shopOrderId, item.currency])).toEqual([
    [first.shopOrderId, 'USD'],
    [second.shopOrderId, 'EUR'],
  ]);
  await signIn(page, owner);
  await page.goto(ordersPath(shop));
  await expect(rowsOf(page)).toHaveCount(2);
  await expect(rowsOf(page).nth(0).locator('td').nth(2)).toHaveText('$123.45');
  await expect(rowsOf(page).nth(1).locator('td').nth(2)).toHaveText('€5.00');
  // a ShopOrder row with no BisOrder is refused by the database (so the inner join can never drop a real slice)
  expect(() => runSql(`insert into "ShopOrder"(id,"bisOrderId","shopId",subtotal,status) values (gen_random_uuid(), gen_random_uuid(), '${shop}', 1, 'PAID')`)).toThrow();
  expect(scalar(`select count(*) from "ShopOrder" where "shopId"='${shop}'`)).toBe('2');
});

test('[orders.db.null-shopid] a slice whose shop is NULL is never listed, for any shop', async () => {
  lines('orders.db.null-shopid');
  const shop = await newShop();
  const other = await newShop();
  const [, orphan] = seedSlices(shop, buyerId, [{ createdAt: at(1) }, { createdAt: at(2), noShop: true }, { createdAt: at(3) }]);
  expect(scalar(`select count(*) from "ShopOrder" where id='${orphan.shopOrderId}' and "shopId" is null`)).toBe('1');
  expect((await read(shop)).map((item) => item.shopOrderId)).not.toContain(orphan.shopOrderId);
  expect(await read(shop)).toHaveLength(2);
  expect(await read(other)).toHaveLength(0);
});

test('[orders.db.lines-join, orders.table.items-only-this-shop] an order across two shops lists each shop its own lines, once', async ({ page }) => {
  lines('orders.db.lines-join');
  const shopA = await newShop();
  const shopB = await newShop();
  const [made] = seedSlices(shopA, buyerId, [{ createdAt: at(1), subtotal: 3000, lines: 2 }]);
  const idB = crypto.randomUUID();
  runSql(`insert into "ShopOrder"(id,"bisOrderId","shopId",subtotal,status,"createdAt","updatedAt") values ('${idB}','${made.orderId}','${shopB}',700,'PENDING','${at(1)}','${at(1)}');
          insert into "BisOrderItem"(id,"bisOrderId","productId",quantity,"priceAtPurchase","createdAt","updatedAt","shopId",title,"discountMinor","lineTotalMinor") values
          (gen_random_uuid(),'${made.orderId}',gen_random_uuid(),1,300,now(),now(),'${shopB}','B one',0,300),
          (gen_random_uuid(),'${made.orderId}',gen_random_uuid(),1,400,now(),now(),'${shopB}','B two',0,400)`);
  const a = await read(shopA);
  const b = await read(shopB);
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  expect(a[0].items.map((item) => item.shopId)).toEqual([shopA, shopA]);
  expect(b[0].items.map((item) => item.shopId)).toEqual([shopB, shopB]);
  expect(b[0].items.map((item) => item.lineTotalMinor).sort()).toEqual([300, 400]);
  expect(a[0].subtotalMinor).toBe(3000);
  expect(b[0].subtotalMinor).toBe(700);
  await signIn(page, owner);
  await page.goto(ordersPath(shopB));
  await expect(rowsOf(page)).toHaveCount(1);
  await expect(rowsOf(page).first().locator('td').nth(1)).toHaveText('2');
});

test('[orders.db.line-title-null] a NULL line title is empty text and a NULL line total falls back to unit price times quantity', async () => {
  lines('orders.db.line-title-null');
  const shop = await newShop();
  seedSlices(shop, buyerId, [{ createdAt: at(1), subtotal: 900, nullTitle: true, nullLineTotal: true }]);
  runSql(`update "BisOrderItem" set quantity=3, "priceAtPurchase"=300 where "shopId"='${shop}'`);
  const item = (await read(shop))[0].items[0] as unknown as { title: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number };
  expect(rows(`select title, "lineTotalMinor" is null from "BisOrderItem" where "shopId"='${shop}'`)).toEqual([['', 't']]);
  expect(item.title).toBe('');
  expect(item.quantity).toBe(3);
  expect(item.lineTotalMinor).toBe(900);
});

test('[orders.db.keyset-index, orders.db.index-use] with 10 000 slices the list reads the keyset index with no sort, first page and a deep page are fast', async ({ page }) => {
  lines('orders.db.keyset-index', 'orders.db.index-use');
  const shop = await newShop();
  runSql(`with g as (select gen_random_uuid() as oid, gen_random_uuid() as sid, i from generate_series(1, 10000) i),
               b as (insert into "BisOrder"(id,"userId","createdAt","updatedAt",status,total,currency) select oid,'${buyerId}', now() - (i || ' seconds')::interval, now(), 'RESERVED', 1000, 'EUR' from g returning id)
          insert into "ShopOrder"(id,"bisOrderId","shopId",subtotal,status,"createdAt","updatedAt") select sid, oid, '${shop}', 1000, 'PENDING', now() - (i || ' seconds')::interval, now() from g;
          analyze "ShopOrder"; analyze "BisOrder"`);
  expect(scalar(`select count(*) from "ShopOrder" where "shopId"='${shop}'`)).toBe('10000');
  const plan = runSql(`explain (analyze, buffers) SELECT so."id", so."bisOrderId" AS "orderId", so."status", so."subtotal", o."currency", so."createdAt"
       FROM "ShopOrder" so JOIN "BisOrder" o ON o."id" = so."bisOrderId"
       WHERE so."shopId" = '${shop}' AND (so."createdAt", so."id") < (now() - interval '5000 seconds', 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid)
       ORDER BY so."createdAt" DESC, so."id" DESC LIMIT 21`);
  expect(plan, plan).toContain('ShopOrder_shop_keyset_idx');
  expect(plan, plan).not.toMatch(/Sort\b/);
  expect(plan, plan).not.toContain('Seq Scan on "ShopOrder"');
  const execution = Number(plan.match(/Execution Time: ([\d.]+) ms/)?.[1]);
  expect(execution, plan).toBeLessThan(100);
  // through the API: first page and a deep page
  const started = Date.now();
  const first = await sellerCall('GET', `/api/shops/${shop}/orders?limit=20`, undefined, token);
  expect(first.status).toBe(200);
  expect(Date.now() - started).toBeLessThan(2000);
  let cursor = first.data.nextCursor as string;
  for (let step = 0; step < 24; step += 1) cursor = (await sellerCall('GET', `/api/shops/${shop}/orders?limit=100&cursor=${encodeURIComponent(cursor)}`, undefined, token)).data.nextCursor ?? cursor;
  const deepStart = Date.now();
  const deep = await sellerCall('GET', `/api/shops/${shop}/orders?limit=20&cursor=${encodeURIComponent(cursor)}`, undefined, token);
  expect(deep.status).toBe(200);
  expect(Date.now() - deepStart).toBeLessThan(2000);
  await signIn(page, owner);
  await page.goto(ordersPath(shop));
  await expect(rowsOf(page)).toHaveCount(20);
});
