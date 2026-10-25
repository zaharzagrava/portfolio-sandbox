import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { API_URL, register, resetRateLimits, sellerCall } from '../helpers';
import { PIXEL_PNG, readGallery, readProduct, shopPath, tokenOf, uniqueTitle } from '../seller/cross-cutting/support';
import { openShopByApi } from '../seller-setup';

/**
 * AI QA, track "fault-injection" (map: scripts/aiqa/coverage/fault-injection.tsv, how to use it: scripts/aiqa/tracks/fault-injection/README.md).
 *
 * This spec PAUSES NOTHING itself and skips itself unless the runner started it: `node scripts/aiqa/tracks/fault-injection/run.mjs <dependency>`
 * pauses ONE dependency container of the dev stack while this spec acts, and sets AIQA_FAULT=1, FAULT_DEP and FAULT_DIR. The normal suite
 * therefore never pauses a container. The two talk through flag files in FAULT_DIR:
 *   spec: set-up while everything is healthy, writes `ready`  ->  runner: `docker pause`, writes `paused`
 *   spec: the "during the outage" tests act on the screen (one per action), then the "window" test writes `paused-done`
 *   runner: `docker unpause`, writes `resumed`  ->  spec: the "after recovery" tests retry and read the saved data back.
 * `afterAll` writes `abort` so the runner unpauses even when this spec crashes (the runner also unpauses on its own exit).
 *
 * One map line per outage x action: `fault.<dependency>.<action>`. Each line has TWO tests, both annotated with the line id and both
 * must pass for the line to pass:
 *   "during the outage": the screen ends in an honest state within 25 s (a success toast, or an error message; never an endless
 *   spinner, never raw SQL/stack text), and
 *   "after recovery": the same action by the seller succeeds exactly once (no duplicate, no half-written row), and a success toast
 *   that was shown is backed by the saved row.
 * The line `fault.<dependency>.outbox-published` checks that every outbox row of the shop is published after recovery.
 * (The two phases are two tests because one pause window serves all actions: pausing and waiting for recovery eight times would take
 * four times as long and each pause is announced to the other testers in /tmp/fe/fault-window.txt.)
 */

const DEP = process.env.FAULT_DEP ?? '';
const DIR = process.env.FAULT_DIR ?? '';
const ENABLED = process.env.AIQA_FAULT === '1' && !!DEP && !!DIR;
/** The map names the database "postgres"; the runner's key is "db". */
const LINE_DEP = DEP === 'db' || DEP === 'postgres' ? 'postgres' : DEP;
const LIMIT_MS = 25_000; // no spinner / pending dialog may outlast this (the app sets no client timeout of its own)
const SUCCESS = /^(Product created|Product updated|Stock updated|Product archived|Photos saved|Product restored)$/;
const ERROR = /(went wrong|couldn't|can't|didn't work|try again|unavailable|too many|offline|no longer|failed|error)/i;
const LEAK = /(Sequelize|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ESOCKET|ENOTFOUND|kafkajs|ioredis|ElasticsearchClient|ConnectionError|relation "|syntax error|SELECT |INSERT |UPDATE "|\bat [\w.<>]+ \(.*:\d+:\d+\)|node_modules|\/home\/|stack trace|\bTypeError\b|\bReferenceError\b|\{"statusCode")/;

/** Every line of the map (kept literal so scripts/aiqa/run-specs.mjs can see which lines this spec covers). */
const LINE_IDS = [
  'fault.postgres.create-product', 'fault.postgres.edit-product', 'fault.postgres.stock-change', 'fault.postgres.archive-product', 'fault.postgres.photo-upload', 'fault.postgres.shop-open', 'fault.postgres.inventory-load', 'fault.postgres.orders-load', 'fault.postgres.outbox-published',
  'fault.redis.create-product', 'fault.redis.edit-product', 'fault.redis.stock-change', 'fault.redis.archive-product', 'fault.redis.photo-upload', 'fault.redis.shop-open', 'fault.redis.inventory-load', 'fault.redis.orders-load', 'fault.redis.outbox-published',
  'fault.kafka.create-product', 'fault.kafka.edit-product', 'fault.kafka.stock-change', 'fault.kafka.archive-product', 'fault.kafka.photo-upload', 'fault.kafka.shop-open', 'fault.kafka.inventory-load', 'fault.kafka.orders-load', 'fault.kafka.outbox-published',
  'fault.elasticsearch.create-product', 'fault.elasticsearch.edit-product', 'fault.elasticsearch.stock-change', 'fault.elasticsearch.archive-product', 'fault.elasticsearch.photo-upload', 'fault.elasticsearch.shop-open', 'fault.elasticsearch.inventory-load', 'fault.elasticsearch.orders-load', 'fault.elasticsearch.outbox-published',
  'fault.minio.create-product', 'fault.minio.edit-product', 'fault.minio.stock-change', 'fault.minio.archive-product', 'fault.minio.photo-upload', 'fault.minio.shop-open', 'fault.minio.inventory-load', 'fault.minio.orders-load', 'fault.minio.outbox-published',
  'fault.scylla.create-product', 'fault.scylla.edit-product', 'fault.scylla.stock-change', 'fault.scylla.archive-product', 'fault.scylla.photo-upload', 'fault.scylla.shop-open', 'fault.scylla.inventory-load', 'fault.scylla.orders-load', 'fault.scylla.outbox-published',
  'fault.elasticmq.create-product', 'fault.elasticmq.edit-product', 'fault.elasticmq.stock-change', 'fault.elasticmq.archive-product', 'fault.elasticmq.photo-upload', 'fault.elasticmq.shop-open', 'fault.elasticmq.inventory-load', 'fault.elasticmq.orders-load', 'fault.elasticmq.outbox-published',
  'fault.clamav.create-product', 'fault.clamav.edit-product', 'fault.clamav.stock-change', 'fault.clamav.archive-product', 'fault.clamav.photo-upload', 'fault.clamav.shop-open', 'fault.clamav.inventory-load', 'fault.clamav.orders-load', 'fault.clamav.outbox-published',
  'fault.clickhouse.create-product', 'fault.clickhouse.edit-product', 'fault.clickhouse.stock-change', 'fault.clickhouse.archive-product', 'fault.clickhouse.photo-upload', 'fault.clickhouse.shop-open', 'fault.clickhouse.inventory-load', 'fault.clickhouse.orders-load', 'fault.clickhouse.outbox-published',
];

const lineId = (action: string) => `fault.${LINE_DEP || '<dependency>'}.${action}`;
function lines(action: string) {
  const id = lineId(action);
  expect(LINE_IDS, `${id} is a line of the map`).toContain(id);
  test.info().annotations.push({ type: 'aiqa-lines', description: id });
}

const flag = (name: string) => path.join(DIR, name);
const trace = (message: string) => {
  if (DIR) appendFileSync(flag('trace.log'), `${new Date().toISOString()} ${message}\n`);
};
const raise = (name: string) => writeFileSync(flag(name), String(Date.now()));
async function waitFlag(name: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(flag(name))) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the runner did not write "${name}" within ${ms} ms`);
}

// ---- direct database read of the outbox (the same connection settings the seed scripts use)
function dbClient() {
  const backend = path.resolve(__dirname, '../../../backend');
  const req = createRequire(path.join(backend, 'package.json'));
  const { Client } = req('pg');
  const env = Object.fromEntries(
    readFileSync(path.join(backend, '.env'), 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]),
  );
  return new Client({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USERNAME, password: env.DB_PASSWORD, database: env.DB_NAME });
}
async function outboxNotPublished(shopId: string, productIds: string[]): Promise<{ n: number; sample: unknown[] }> {
  const db = dbClient();
  await db.connect();
  try {
    const rows = await db.query(
      `SELECT "eventName", status, attempts, "parkedReason", "aggregateId" FROM "Outbox"
        WHERE status <> 'published' AND ("aggregateId" = ANY($1) OR "aggregateId" = $2 OR payload::text LIKE $3)`,
      [productIds, shopId, `%${shopId}%`],
    );
    return { n: rows.rowCount ?? 0, sample: rows.rows.slice(0, 5) };
  } finally {
    await db.end();
  }
}

type Observation = { action: string; outcome: 'success' | 'error' | 'pending' | 'redirected'; text: string; ms: number; leak: string | null; url?: string };

/** What the whole visible page (dialogs and toasts included) says right now. */
const visibleText = (page: Page) =>
  page
    .evaluate(() => {
      const pick = (selector: string) => Array.from(document.querySelectorAll(selector)).map((el) => (el as HTMLElement).innerText).join(' | ');
      return `DIALOG: ${pick('[role="dialog"]')} || TOAST: ${pick('[data-sonner-toast]')} || MAIN: ${pick('#main-content')}`.replace(/\s+/g, ' ');
    })
    .catch(() => '');

/** After the click that sends the request: waits (at most LIMIT_MS) for a success toast, an error message, or the page leaving. */
async function settle(page: Page, action: string, started: number, successUrl?: RegExp): Promise<Observation> {
  const deadline = started + LIMIT_MS;
  let text = '';
  while (Date.now() < deadline) {
    text = await visibleText(page);
    if (successUrl?.test(page.url())) return { action, outcome: 'success', text: 'moved to ' + page.url(), ms: Date.now() - started, leak: text.match(LEAK)?.[0] ?? null };
    if (/\/login/.test(page.url())) return { action, outcome: 'redirected', text: 'redirected to ' + page.url(), ms: Date.now() - started, leak: text.match(LEAK)?.[0] ?? null, url: page.url() };
    const toasts = await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => [] as string[]);
    const success = toasts.map((t) => t.trim()).find((t) => SUCCESS.test(t.split('\n')[0] ?? ''));
    if (success) return { action, outcome: 'success', text: success, ms: Date.now() - started, leak: text.match(LEAK)?.[0] ?? null };
    const alerts = await page.locator('[role="alert"], [data-sonner-toast], [data-testid="problem"]').allInnerTexts().catch(() => [] as string[]);
    const error = alerts.map((t) => t.trim()).find((t) => t && ERROR.test(t));
    if (error) return { action, outcome: 'error', text: error.slice(0, 300), ms: Date.now() - started, leak: text.match(LEAK)?.[0] ?? null };
    await page.waitForTimeout(250);
  }
  return { action, outcome: 'pending', text: text.slice(0, 400), ms: Date.now() - started, leak: text.match(LEAK)?.[0] ?? null };
}

/** A page load: honest = content or an error state within the limit, never a skeleton for ever, no raw text. */
async function observeLoad(page: Page, action: string, url: string): Promise<Observation> {
  const started = Date.now();
  try {
    await page.goto(url, { timeout: LIMIT_MS, waitUntil: 'domcontentloaded' });
  } catch (error) {
    return { action, outcome: 'pending', text: `navigation did not finish in ${LIMIT_MS} ms: ${(error as Error).message.split('\n')[0]}`, ms: Date.now() - started, leak: null };
  }
  const deadline = started + LIMIT_MS;
  while (Date.now() < deadline) {
    const skeletons = await page.locator('.animate-pulse').count().catch(() => 0);
    const text = await visibleText(page);
    if (/\/login/.test(page.url())) return { action, outcome: 'redirected', text: 'redirected to ' + page.url(), ms: Date.now() - started, leak: null, url: page.url() };
    if (skeletons === 0 && text.trim().length > 0) {
      const settled = ERROR.test(text) && !(await page.locator('tbody tr').count().catch(() => 0));
      return { action, outcome: settled ? 'error' : 'success', text: text.replace(/\s+/g, ' ').slice(0, 300), ms: Date.now() - started, leak: text.match(LEAK)?.[0] ?? null, url: page.url() };
    }
    await page.waitForTimeout(250);
  }
  return { action, outcome: 'pending', text: (await visibleText(page)).replace(/\s+/g, ' ').slice(0, 300), ms: Date.now() - started, leak: null, url: page.url() };
}

/** The photos page loads its list in the browser; the dev server may reload the page under a hot update, so a stuck skeleton is retried. */
async function openPhotoPage(p: Page, url: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await p.bringToFront();
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    if (await p.getByLabel('Add photos').waitFor({ state: 'attached', timeout: 30_000 }).then(() => true, () => false)) return;
  }
  throw new Error('the photos page never showed its "Add photos" control (5 loads)');
}

async function waitForApi(ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${API_URL}/health/ready`, { signal: AbortSignal.timeout(3000) })).ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** A test must never throw half way (the later phases depend on its state): a hard failure becomes a failed soft check with the reason. */
async function guard(label: string, body: () => Promise<void>) {
  try {
    await body();
  } catch (error) {
    expect.soft(false, `${label}: ${(error as Error).message.split('\n')[0]}`).toBe(true);
  }
}

type Fixture = {
  contexts: BrowserContext[];
  pages: Record<'create' | 'edit' | 'stock' | 'archive' | 'photo' | 'inventory' | 'orders', Page>;
  newcomerPage: Page;
  newcomerToken: string;
  newShopName: string;
  shopId: string;
  token: string;
  edit: { id: string; title: string };
  stock: { id: string; title: string };
  archive: { id: string; title: string };
  photo: { id: string; title: string };
  productIds: string[];
  newTitle: string;
  editedBrand: string;
  photoBefore: number;
};
let fx: Fixture;
const seen: Record<string, Observation> = {};
const observations: Observation[] = [];

test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

test.describe(`Fault injection: ${DEP || '(no dependency named)'} paused`, () => {
  test.skip(!ENABLED, 'pauses containers: only the runner starts it (node scripts/aiqa/tracks/fault-injection/run.mjs <dependency>, which sets AIQA_FAULT=1, FAULT_DEP and FAULT_DIR)');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    mkdirSync(DIR, { recursive: true });
    // ---------------------------------------------------------------- set-up while everything is healthy
    const owner = await browser.newContext();
    await owner.route('**/api/streams**', (route) => route.abort()); // every open tab holds a live-update stream and a browser allows 6 connections per address: not what is tested here
    const page = await owner.newPage();
    const member = await register(page);
    const { shopId } = await openShopByApi(member);
    const token = await tokenOf(member);
    const mk = async (title: string, quantity = 8) => {
      const r = await sellerCall('POST', `/api/shops/${shopId}/products`, { title, brand: 'Fault', category: 'fault', priceMinor: 1999, quantity, description: 'fault injection' }, token);
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return { id: r.data.id as string, title };
    };
    const edit = await mk(uniqueTitle('Fault Edit'));
    const stock = await mk(uniqueTitle('Fault Stock'));
    const archive = await mk(uniqueTitle('Fault Archive'));
    const photo = await mk(uniqueTitle('Fault Photo'));

    // a member without a shop, for the open-shop form
    const newcomerContext = await browser.newContext();
    await newcomerContext.route('**/api/streams**', (route) => route.abort());
    const newcomerPage = await newcomerContext.newPage();
    const newcomer = await register(newcomerPage);
    const newcomerToken = await tokenOf(newcomer);

    // one page per action, opened and warmed while healthy; background tabs do not run client effects reliably, so each is warmed in the foreground
    const pages = {
      create: page,
      edit: await owner.newPage(),
      stock: await owner.newPage(),
      archive: await owner.newPage(),
      photo: await owner.newPage(),
      inventory: await owner.newPage(),
      orders: await owner.newPage(),
    };
    for (const p of [pages.create, pages.edit, pages.stock, pages.archive]) {
      await p.bringToFront();
      await p.goto(shopPath(shopId, 'inventory'));
      await expect(p.getByRole('button', { name: 'Add product' }).first()).toBeVisible();
    }
    await openPhotoPage(pages.photo, shopPath(shopId, `products/${photo.id}/media`));
    await pages.photo.getByRole('list', { name: 'Photos' }).waitFor({ state: 'attached', timeout: 30_000 }).catch(() => undefined);
    await newcomerPage.bringToFront();
    await newcomerPage.goto('/dashboard/seller');
    await expect(newcomerPage.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();

    const productIds = [edit.id, stock.id, archive.id, photo.id];
    fx = {
      contexts: [owner, newcomerContext],
      pages,
      newcomerPage,
      newcomerToken,
      newShopName: `Fault Shop ${Date.now().toString(36)}`,
      shopId,
      token,
      edit,
      stock,
      archive,
      photo,
      productIds,
      newTitle: uniqueTitle('Fault Created'),
      editedBrand: `Edited-${Date.now().toString(36)}`,
      photoBefore: (await readGallery(token, shopId, photo.id)).items.length,
    };

    // all earlier outbox rows are published before the pause, so every row left over afterwards belongs to the fault window
    await expect.poll(async () => (await outboxNotPublished(shopId, productIds)).n, { timeout: 60_000, message: 'outbox published before the pause' }).toBe(0);

    raise('ready');
    await waitFlag('paused', 300_000);
    trace('paused: the actions start');
  });

  test.afterAll(async () => {
    if (DIR) {
      writeFileSync(flag('observations.json'), JSON.stringify({ dependency: DEP, observations }, null, 1));
      raise('abort'); // the runner unpauses whatever is paused, also when this spec crashed half way
    }
    for (const context of fx?.contexts ?? []) await context.close().catch(() => undefined);
  });

  // ================================================================ DURING the outage: one action each, at most 25 s
  const record = (o: Observation) => {
    seen[o.action] = o;
    observations.push(o);
    writeFileSync(flag('observations.json'), JSON.stringify({ dependency: DEP, observations }, null, 1));
    trace(`${o.action}=${o.outcome} (${o.ms} ms) ${o.text.slice(0, 120)}`);
  };
  const honest = (o: Observation) => {
    expect.soft(o.outcome, `${DEP} paused: "${o.action}" must end in a visible result within ${LIMIT_MS / 1000}s (got ${o.outcome}: ${o.text})`).not.toBe('pending');
    expect.soft(o.leak, `${DEP} paused: "${o.action}" shows raw technical text`).toBeNull();
  };
  const during = async (name: string, page: Page, run: () => Promise<Observation>) => {
    await page.bringToFront();
    const o = await run().catch((error: Error) => ({ action: name, outcome: 'pending', text: `the action itself threw: ${error.message.split('\n')[0]}`, ms: 0, leak: null }) as Observation);
    record({ ...o, action: name });
    honest(o);
  };

  test(`[${lineId('create-product')}] during the outage: Create product ends in a visible result`, async () => {
    lines('create-product');
    test.setTimeout(120_000);
    await during('create-product', fx.pages.create, async () => {
      const p = fx.pages.create;
      await p.getByRole('button', { name: 'Add product' }).first().click();
      const d = p.getByRole('dialog', { name: 'Add product' });
      await d.getByLabel('Title').fill(fx.newTitle);
      await d.getByLabel('Brand').fill('Fault');
      await d.getByLabel('Category').fill('fault');
      await d.getByLabel(/^Price/).fill('12.34');
      await d.getByLabel('Stock').fill('7');
      const started = Date.now();
      await d.getByRole('button', { name: 'Create product' }).click();
      return settle(p, 'create-product', started);
    });
  });

  test(`[${lineId('edit-product')}] during the outage: Save changes in the edit dialog ends in a visible result`, async () => {
    lines('edit-product');
    test.setTimeout(120_000);
    await during('edit-product', fx.pages.edit, async () => {
      const p = fx.pages.edit;
      await p.getByRole('button', { name: `Actions for ${fx.edit.title}` }).click();
      await p.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      const d = p.getByRole('dialog', { name: 'Edit product' });
      await d.getByLabel('Brand').fill(fx.editedBrand);
      const started = Date.now();
      await d.getByRole('button', { name: 'Save changes' }).click();
      return settle(p, 'edit-product', started);
    });
  });

  test(`[${lineId('stock-change')}] during the outage: Update stock ends in a visible result`, async () => {
    lines('stock-change');
    test.setTimeout(120_000);
    await during('stock-change', fx.pages.stock, async () => {
      const p = fx.pages.stock;
      await p.getByRole('button', { name: `Actions for ${fx.stock.title}` }).click();
      await p.getByRole('menuitem', { name: 'Adjust stock', exact: true }).click();
      await p.getByLabel('New stock').fill('3');
      const started = Date.now();
      await p.getByRole('button', { name: 'Update stock' }).click();
      return settle(p, 'stock-change', started);
    });
  });

  test(`[${lineId('archive-product')}] during the outage: Archive product ends in a visible result`, async () => {
    lines('archive-product');
    test.setTimeout(120_000);
    await during('archive-product', fx.pages.archive, async () => {
      const p = fx.pages.archive;
      await p.getByRole('button', { name: `Actions for ${fx.archive.title}` }).click();
      await p.getByRole('menuitem', { name: 'Archive', exact: true }).click();
      const started = Date.now();
      await p.getByRole('dialog', { name: 'Archive product?' }).getByRole('button', { name: 'Archive product' }).click();
      return settle(p, 'archive-product', started);
    });
  });

  test(`[${lineId('photo-upload')}] during the outage: choosing a photo ends in a tile or an error`, async () => {
    lines('photo-upload');
    test.setTimeout(120_000);
    await during('photo-upload', fx.pages.photo, async () => {
      const p = fx.pages.photo;
      const started = Date.now();
      await p.getByLabel('Add photos').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PIXEL_PNG });
      // an upload that cannot finish must say so; success here is the photo tile (not a toast)
      const deadline = started + LIMIT_MS;
      while (Date.now() < deadline) {
        const text = await visibleText(p);
        if (await p.getByRole('list', { name: 'Photos' }).getByRole('img').count()) return { action: 'photo-upload', outcome: 'success', text: 'a photo tile appeared', ms: Date.now() - started, leak: text.match(LEAK)?.[0] ?? null } as Observation;
        const alerts = await p.locator('[role="alert"], [data-sonner-toast]').allInnerTexts().catch(() => [] as string[]);
        const error = alerts.find((t) => ERROR.test(t));
        if (error) return { action: 'photo-upload', outcome: 'error', text: error.slice(0, 300), ms: Date.now() - started, leak: text.match(LEAK)?.[0] ?? null } as Observation;
        await p.waitForTimeout(250);
      }
      return { action: 'photo-upload', outcome: 'pending', text: (await visibleText(p)).replace(/\s+/g, ' ').slice(0, 400), ms: Date.now() - started, leak: null } as Observation;
    });
  });

  test(`[${lineId('shop-open')}] during the outage: Open shop in the new-member form ends in a visible result`, async () => {
    lines('shop-open');
    test.setTimeout(120_000);
    await during('shop-open', fx.newcomerPage, async () => {
      const p = fx.newcomerPage;
      await p.getByLabel('Shop name').fill(fx.newShopName);
      const started = Date.now();
      await p.getByRole('button', { name: 'Open shop' }).click();
      return settle(p, 'shop-open', started, /\/dashboard\/seller\/[0-9a-f-]{36}/);
    });
  });

  test(`[${lineId('inventory-load')}] during the outage: opening Inventory shows rows or an honest error`, async () => {
    lines('inventory-load');
    test.setTimeout(120_000);
    await during('inventory-load', fx.pages.inventory, () => observeLoad(fx.pages.inventory, 'inventory-load', shopPath(fx.shopId, 'inventory')));
  });

  test(`[${lineId('orders-load')}] during the outage: opening Orders shows rows or an honest error`, async () => {
    lines('orders-load');
    test.setTimeout(120_000);
    await during('orders-load', fx.pages.orders, () => observeLoad(fx.pages.orders, 'orders-load', shopPath(fx.shopId, 'orders')));
  });

  // ================================================================ the window closes
  test('window: tell the runner the actions are done, wait for the dependency and the API to be back', async () => {
    test.setTimeout(300_000);
    trace('actions done: ' + observations.map((o) => `${o.action}=${o.outcome}`).join(', '));
    raise('paused-done');
    await waitFlag('resumed', 120_000);
    trace('resumed; waiting for the API');
    expect(await waitForApi(), `the API answers /health/ready again after ${DEP} is unpaused`).toBe(true);
    await resetRateLimits();
  });

  // ================================================================ AFTER recovery: retry, exactly once, data consistent
  const said = (action: string) => seen[action]?.outcome;

  test(`[${lineId('create-product')}] after recovery: one Create product retry gives exactly one product, and the screen told the truth`, async () => {
    lines('create-product');
    test.setTimeout(180_000);
    await guard('create-product recovery', async () => {
      const count = async () => {
        const list = await sellerCall('GET', `/api/shops/${fx.shopId}/products?status=ACTIVE&limit=100`, undefined, fx.token);
        return ((list.data.items ?? []) as { title: string }[]).filter((p) => p.title === fx.newTitle).length;
      };
      const saved = await count();
      expect.soft(saved, `create-product: screen said "${said('create-product')}", rows saved: ${saved}`).toBe(said('create-product') === 'success' ? 1 : 0);
      if (saved === 0) {
        const p = fx.pages.create;
        await p.bringToFront();
        await p.reload();
        await p.getByRole('button', { name: 'Add product' }).first().click();
        const d = p.getByRole('dialog', { name: 'Add product' });
        await d.getByLabel('Title').fill(fx.newTitle);
        await d.getByLabel('Brand').fill('Fault');
        await d.getByLabel('Category').fill('fault');
        await d.getByLabel(/^Price/).fill('12.34');
        await d.getByLabel('Stock').fill('7');
        await d.getByRole('button', { name: 'Create product' }).click();
        await expect(p.getByText('Product created')).toBeVisible({ timeout: 30_000 });
      }
      await expect.poll(count, { timeout: 30_000, message: 'create-product: exactly one product with the title after the retry' }).toBe(1);
      const all = await sellerCall('GET', `/api/shops/${fx.shopId}/products?status=ACTIVE&limit=100`, undefined, fx.token);
      const titles = (all.data.items as { title: string }[]).map((p) => p.title);
      expect.soft(new Set(titles).size, `no duplicate product titles: ${titles.join(' | ')}`).toBe(titles.length);
    });
  });

  test(`[${lineId('edit-product')}] after recovery: one Save changes retry changes the brand once (version +1), and the screen told the truth`, async () => {
    lines('edit-product');
    test.setTimeout(180_000);
    await guard('edit-product recovery', async () => {
      const now = await readProduct(fx.token, fx.shopId, fx.edit.id);
      expect.soft(now.brand === fx.editedBrand, `edit-product: screen said "${said('edit-product')}", saved brand "${now.brand}"`).toBe(said('edit-product') === 'success');
      if (now.brand !== fx.editedBrand) {
        const p = fx.pages.edit;
        await p.bringToFront();
        await p.reload();
        await p.getByRole('button', { name: `Actions for ${fx.edit.title}` }).click();
        await p.getByRole('menuitem', { name: 'Edit', exact: true }).click();
        await p.getByRole('dialog', { name: 'Edit product' }).getByLabel('Brand').fill(fx.editedBrand);
        await p.getByRole('dialog', { name: 'Edit product' }).getByRole('button', { name: 'Save changes' }).click();
        await expect(p.getByText('Product updated')).toBeVisible({ timeout: 30_000 });
      }
      const final = await readProduct(fx.token, fx.shopId, fx.edit.id);
      expect(final.brand).toBe(fx.editedBrand);
      expect.soft(final.version, 'edit-product: version moved by exactly one change').toBe(now.brand === fx.editedBrand ? now.version : now.version + 1);
    });
  });

  test(`[${lineId('stock-change')}] after recovery: one Update stock retry sets the stock once, and the screen told the truth`, async () => {
    lines('stock-change');
    test.setTimeout(180_000);
    await guard('stock-change recovery', async () => {
      const now = await readProduct(fx.token, fx.shopId, fx.stock.id);
      expect.soft(now.quantity === 3, `stock-change: screen said "${said('stock-change')}", saved quantity ${now.quantity}`).toBe(said('stock-change') === 'success');
      if (now.quantity !== 3) {
        const p = fx.pages.stock;
        await p.bringToFront();
        await p.reload();
        await p.getByRole('button', { name: `Actions for ${fx.stock.title}` }).click();
        await p.getByRole('menuitem', { name: 'Adjust stock', exact: true }).click();
        await p.getByLabel('New stock').fill('3');
        await p.getByRole('button', { name: 'Update stock' }).click();
        await expect(p.getByText('Stock updated')).toBeVisible({ timeout: 30_000 });
      }
      const final = await readProduct(fx.token, fx.shopId, fx.stock.id);
      expect(final.quantity).toBe(3);
      expect.soft(final.version, 'stock-change: changed exactly once').toBe(now.quantity === 3 ? now.version : now.version + 1);
    });
  });

  test(`[${lineId('archive-product')}] after recovery: one Archive retry archives the product, and the screen told the truth`, async () => {
    lines('archive-product');
    test.setTimeout(180_000);
    await guard('archive-product recovery', async () => {
      const now = await readProduct(fx.token, fx.shopId, fx.archive.id);
      expect.soft(now.status === 'ARCHIVED', `archive-product: screen said "${said('archive-product')}", saved status ${now.status}`).toBe(said('archive-product') === 'success');
      if (now.status !== 'ARCHIVED') {
        const p = fx.pages.archive;
        await p.bringToFront();
        await p.reload();
        await p.getByRole('button', { name: `Actions for ${fx.archive.title}` }).click();
        await p.getByRole('menuitem', { name: 'Archive', exact: true }).click();
        await p.getByRole('dialog', { name: 'Archive product?' }).getByRole('button', { name: 'Archive product' }).click();
        await expect(p.getByText('Product archived')).toBeVisible({ timeout: 30_000 });
      }
      expect((await readProduct(fx.token, fx.shopId, fx.archive.id)).status).toBe('ARCHIVED');
    });
  });

  test(`[${lineId('photo-upload')}] after recovery: one upload and one Save photos give exactly one photo in the gallery`, async () => {
    lines('photo-upload');
    test.setTimeout(240_000);
    await guard('photo-upload recovery', async () => {
      await fx.pages.photo.close({ runBeforeUnload: false }).catch(() => undefined); // the seller closes the tab with the unsaved photo and opens a new one
      const p = await fx.contexts[0].newPage();
      await openPhotoPage(p, shopPath(fx.shopId, `products/${fx.photo.id}/media`));
      const tiles = p.getByRole('list', { name: 'Photos' }).getByRole('img');
      const before = await tiles.count();
      await p.getByLabel('Add photos').setInputFiles({ name: 'retry.png', mimeType: 'image/png', buffer: PIXEL_PNG });
      await expect(tiles).toHaveCount(before + 1, { timeout: 90_000 });
      const calls: string[] = [];
      p.on('response', (r) => r.request().method() !== 'GET' && calls.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`));
      p.on('requestfailed', (r) => calls.push(`FAILED ${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`));
      await p.getByRole('button', { name: 'Save photos' }).click();
      const saved = await settle(p, 'save-photos-after-recovery', Date.now());
      trace(`save calls: ${JSON.stringify(calls)}`);
      expect(saved.outcome, `save photos after recovery: ${saved.text}`).toBe('success');
      const gallery = await readGallery(fx.token, fx.shopId, fx.photo.id);
      expect.soft(gallery.items.length, `photo-upload: gallery after one retry (had ${fx.photoBefore} before; the paused attempt showed "${said('photo-upload')}")`).toBe(fx.photoBefore + 1);
      expect.soft(new Set(gallery.items.map((i) => i.mediaId)).size, 'photo-upload: no duplicate media in the gallery').toBe(gallery.items.length);
    });
  });

  test(`[${lineId('shop-open')}] after recovery: one Open shop retry gives exactly one shop, and the screen told the truth`, async () => {
    lines('shop-open');
    test.setTimeout(180_000);
    await guard('shop-open recovery', async () => {
      const mine = async () => ((await sellerCall('GET', '/api/shops/mine?limit=50', undefined, fx.newcomerToken)).data.items ?? []) as { name: string }[];
      const saved = (await mine()).filter((s) => s.name === fx.newShopName).length;
      expect.soft(saved, `shop-open: screen said "${said('shop-open')}", shops saved ${saved}`).toBe(said('shop-open') === 'success' ? 1 : 0);
      if (saved === 0) {
        await resetRateLimits();
        await fx.newcomerPage.bringToFront();
        await fx.newcomerPage.goto('/dashboard/seller');
        await fx.newcomerPage.getByLabel('Shop name').fill(fx.newShopName);
        await fx.newcomerPage.getByRole('button', { name: 'Open shop' }).click();
        await expect(fx.newcomerPage).toHaveURL(/\/dashboard\/seller\/[0-9a-f-]{36}/, { timeout: 30_000 });
      }
      expect((await mine()).filter((s) => s.name === fx.newShopName), 'shop-open: exactly one shop after the retry').toHaveLength(1);
    });
  });

  for (const [action, section] of [
    ['inventory-load', 'inventory'],
    ['orders-load', 'orders'],
  ] as const) {
    test(`[${lineId(action)}] after recovery: ${section} opens with its content again`, async () => {
      lines(action);
      test.setTimeout(120_000);
      await guard(`${action} recovery`, async () => {
        await fx.pages.inventory.bringToFront();
        const o = await observeLoad(fx.pages.inventory, `reopen-${section}`, shopPath(fx.shopId, section));
        expect.soft(o.outcome, `after recovery ${section} opens (got ${o.outcome}: ${o.text})`).toBe('success');
      });
    });
  }

  test(`[${lineId('outbox-published')}] after recovery: every outbox row of the shop is published within 2 minutes`, async () => {
    lines('outbox-published');
    test.setTimeout(240_000);
    await guard('outbox recovery', async () => {
      let left = await outboxNotPublished(fx.shopId, fx.productIds);
      for (let i = 0; i < 24 && left.n > 0; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        left = await outboxNotPublished(fx.shopId, fx.productIds);
      }
      expect.soft(left.n, `outbox rows still not published 2 minutes after recovery: ${JSON.stringify(left.sample)}`).toBe(0);
    });
  });
});
