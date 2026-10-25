import { existsSync, readFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { NEW_USER_PASSWORD, SEED, clickThroughDevOverlay, register, sellerCall, totp, uniqueEmail, waitForForm } from './helpers';
import { UNKNOWN_ID, forced, mainText, openSecondShop, tokenOf, watchApi } from './seller/cross-cutting/support';
import { openShopByApi } from './seller-setup';
import { rows, scalar, setShopStatus, userId } from './seller/support/db';
import { covers, isPhone, ownerByApi, sellerNav } from './support/seller-entry';

// ---- the shop frame
{
/**
 * AI QA, area "entry", pass 2, section "the shop frame" (the layout of /dashboard/seller/<shopId>/**): sign-in redirects, the one
 * not-found page, the loading skeletons, page title and the data the server hands to the browser. Each test names the map
 * lines it covers (scripts/aiqa/coverage/entry.tsv) in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const API_LOG = process.env.AIQA_API_LOG ?? '/tmp/fe/api.log';

async function signIn(page: Page, email: string, returnTo: string) {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await waitForForm(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(NEW_USER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('entry: the shop frame', () => {
  test('W04 AS-84: a signed-out visit to a section keeps the section and the query, and after sign-in the browser returns there @desktop', async ({ page }) => {
    covers('entry.frame.signed-out-shop-url', 'entry.frame.returnto-nested-path-only');
    const member = await register(page);
    const { shopId } = await openShopByApi(member);
    await page.context().clearCookies();
    const target = `${HOME}/${shopId}/orders?status=PAID&x=1`;
    await page.goto(target);
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(target)}`);
    await signIn(page, member.email, target);
    await expect(page).toHaveURL(target);
  });

  test('W04 AS-84: repeated query parameters stay repeated and encoded; unsafe return addresses fall back to the home page after sign-in @desktop', async ({ page }) => {
    covers('entry.frame.returnto-keeps-query');
    const member = await register(page);
    const { shopId } = await openShopByApi(member);
    await page.context().clearCookies();
    // A full shop address in returnTo is honoured by the sign-in form, repeated parameters and all.
    const deep = `${HOME}/${shopId}/orders?status=PAID&status=SHIPPED`;
    await signIn(page, member.email, deep);
    await expect(page).toHaveURL(deep);
    await page.context().clearCookies();
    // The front door keeps every repeated parameter.
    await page.goto(`${HOME}?a=1&a=2&cursor=x%20y`);
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(`${HOME}?a=1&a=2&cursor=x+y`)}`);
    // Unsafe addresses are dropped by the sign-in form: the member lands on the home page, never off-site.
    for (const unsafe of ['//evil.example/x', '/\\evil.example', `/${'a'.repeat(520)}`, '/ok%0d%0aSet-Cookie:x', 'https://evil.example/']) {
      await signIn(page, member.email, unsafe);
      await expect(page, unsafe.slice(0, 30)).toHaveURL('http://localhost:3000/');
      await page.context().clearCookies();
    }
  });

  test('W04 AS-85: every shop that is not yours is the same page, with no hint, no shell and no call for a malformed id @desktop', async ({ page }) => {
    covers('entry.frame.malformed-shop-id', 'entry.frame.unknown-shop-id', 'entry.frame.foreign-shop-id', 'entry.frame.deleted-shop', 'entry.frame.not-found-page', 'entry.frame.not-found-no-shell');
    const member = await register(page);
    const mine = await openShopByApi(member);
    const foreign = await ownerByApi();
    const deleted = await openShopByApi(member, 'Aiqa To Be Deleted');
    setShopStatus(deleted.shopId, 'DELETED');
    const malformed = `not-a-uuid-${Date.now().toString(36)}`;
    const cases: [string, string][] = [
      ['malformed', malformed],
      ['unknown', UNKNOWN_ID],
      ['foreign', foreign.shopId],
      ['deleted', deleted.shopId],
      ['malformed section', `${malformed}/inventory`],
    ];
    const seen: Record<string, { text: string; title: string }> = {};
    const api = watchApi(page);
    for (const [label, path] of cases) {
      await page.goto(`${HOME}/${path}`);
      const heading = page.getByRole('heading', { name: "We couldn't find that shop." });
      await expect(heading, label).toBeVisible();
      await expect(page.getByText('Check the address, or choose one of your shops.')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Your shops' }).last()).toHaveAttribute('href', HOME);
      // No shell: no Seller navigation, no sidebar, no drawer button of the shop bar.
      await expect(page.getByRole('navigation', { name: 'Seller' })).toHaveCount(0);
      await expect(page.locator('aside')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Shop bar' })).toHaveCount(0);
      // The site header still works.
      await expect(page.getByRole('banner').getByRole('link', { name: 'Marketplace home' })).toBeVisible();
      // The visited address (or the id) is never repeated on the page.
      const body = await page.locator('body').innerText();
      expect(body).not.toContain(path.split('/')[0]!);
      seen[label] = { text: (await page.locator('#main-content').innerText()).trim(), title: await page.title() };
    }
    // Identical in all cases: same words, same title.
    const first = seen.unknown!;
    for (const [label, got] of Object.entries(seen)) expect(got.text, label).toEqual(first.text);
    // The title the not-found page declares is "Shop not found", the same for every case (soft: the other checks go on).
    for (const [label, got] of Object.entries(seen)) expect.soft(got.title, `title of the ${label} case`).toBe('Shop not found · Marketplace');
    expect(await page.locator('meta[name="robots"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('content')))).toEqual(expect.arrayContaining([expect.stringContaining('noindex')]));
    // The two real HTTP answers for an unknown and a foreign shop are the same.
    const answers = [];
    for (const id of [UNKNOWN_ID, foreign.shopId, malformed]) {
      const response = await page.request.get(`${HOME}/${id}`);
      answers.push([response.status(), (await response.text()).includes("We couldn't find that shop.")]);
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[1]).toEqual(answers[2]);
    expect(answers[0]![1]).toBe(true);
    // B-026: the root loading boundary flushes the page shell (200) before the shop is read, so Next cannot turn notFound() into a 404 here; noindex is sent instead.
    expect(answers[0]![0], 'the not-found page answers 200 (streamed shell) and says so in words').toBe(200);

    // The API: unknown, foreign, deleted are the same 404; the page's client made no shop call of its own.
    const token = (await sellerCall('POST', '/api/auth/login', { email: member.email, password: NEW_USER_PASSWORD })).data.accessToken.token as string;
    const apiAnswers = await Promise.all([UNKNOWN_ID, foreign.shopId, deleted.shopId, 'not-a-uuid'].map((id) => sellerCall('GET', `/api/shops/${id}`, undefined, token)));
    expect(apiAnswers.map((r) => [r.status, r.data.code])).toEqual(Array(4).fill([404, 'shop_not_found']));
    expect(api.count('GET', /\/shops\/(not-a-uuid|[0-9a-f-]{36})$/)).toBe(0);
    expect(scalar(`select status from "Shop" where id='${deleted.shopId}'`)).toBe('DELETED');
    expect(rows(`select count(*) from "ShopMembership" where "shopId"='${foreign.shopId}' and "userId"='${userId(member.email)}'`)[0]![0]).toBe('0');
    expect(mine.shopId).toBeTruthy();

    // A malformed id is answered by the web server alone: the API never saw it.
    if (existsSync(API_LOG)) {
      const log = readFileSync(API_LOG, 'utf8');
      expect(log.includes(`/api/shops/${malformed}`), 'the API log has no request for the malformed id').toBe(false);
      expect(log.includes(`/api/shops/${UNKNOWN_ID}`), 'the API log does show a request for a valid unknown id').toBe(true);
    } else {
      test.info().annotations.push({ type: 'note', description: `no API log at ${API_LOG}: the "no request" half of malformed-shop-id was not checked` });
    }
  });

  test('W04 AS-91, AS-98: the page streams a text-free skeleton first, the title and robots are set, and nothing is cached @desktop', async ({ page }) => {
    covers('entry.frame.loading-skeleton', 'entry.frame.page-loading-skeleton', 'entry.frame.title-noindex');
    const member = await register(page);
    const { shopId } = await openShopByApi(member);
    const response = await page.request.get(`${HOME}/${shopId}`);
    const html = await response.text();
    expect(response.status()).toBe(200);
    // The shell skeleton: shaped like the shell, hidden from readers, no words.
    const shell = html.match(/<div[^>]*data-skeleton="shell"[^>]*>/);
    expect(shell, 'the shell skeleton is in the first answer').not.toBeNull();
    expect(shell![0]).toContain('aria-hidden="true"');
    const shellText = await page.evaluate((markup) => {
      const node = new DOMParser().parseFromString(markup, 'text/html').querySelector('[data-skeleton="shell"]');
      return { text: node?.textContent?.trim() ?? null, spinner: !!node?.querySelector('[role="progressbar"], .animate-spin') };
    }, html);
    expect(shellText).toEqual({ text: '', spinner: false });
    // The default content skeleton of a shop page (loading.tsx) is the overview's skeleton: grey blocks only.
    expect((html.match(/data-slot="skeleton"/g) ?? []).length).toBeGreaterThan(5);
    // Title, robots, caching.
    await page.goto(`${HOME}/${shopId}`);
    // The layout's "Seller dashboard" is the default; the overview page sets its own title, so the overview reads "Overview".
    await expect(page).toHaveTitle('Overview · Marketplace');
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute('content', 'noindex, nofollow');
    const cache = response.headers()['cache-control'] ?? '';
    expect(cache, 'cache-control of a per-member page').toMatch(/no-store|private|no-cache/);
  });

  test('W04 AS-98: the shop and the shop list come with the page; the browser asks for neither on first paint @desktop', async ({ page }) => {
    covers('entry.frame.hydration-seed');
    const member = await register(page);
    const { shopId, shopName } = await openShopByApi(member);
    const api = watchApi(page);
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('heading', { level: 1, name: shopName })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    expect(api.count('GET', /\/shops\/mine$/)).toBe(0);
    expect(api.count('GET', new RegExp(`/shops/${shopId}$`))).toBe(0);
    expect(api.seen.filter((entry) => entry.status !== null && entry.status >= 400)).toEqual([]);
  });

  test('W04 AS-89: a shop whose answer cannot be read shows the error page inside the shell area with a reference, and Try again works @desktop', async ({ page }) => {
    covers('entry.frame.shop-5xx', 'entry.frame.error-try-again');
    const member = await register(page);
    const { shopId } = await openShopByApi(member);
    // The only way to a failing shop read on this stack: the stored plan holds a value the API's answer cannot describe.
    const before = scalar(`select plan from "Shop" where id='${shopId}'`);
    const { execFileSync } = await import('node:child_process');
    const sql = (statement: string) => execFileSync('docker', ['exec', '-i', process.env.AIQA_DB_CONTAINER ?? 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', statement]);
    sql(`update "Shop" set plan='AIQA_BROKEN' where id='${shopId}'`);
    try {
      await page.goto(`${HOME}/${shopId}`);
      await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
      await expect(page.locator('#main-content').getByRole('alert')).toContainText('Reference:');
      await expect(page.locator('body')).not.toContainText('shop_unavailable');
      await expect(page.locator('body')).not.toContainText('AIQA_BROKEN');
      const tryAgain = page.getByRole('button', { name: 'Try again' });
      await expect(tryAgain).toBeVisible();
      // Repair the row, then press Try again: the page must come back.
      sql(`update "Shop" set plan='${before}' where id='${shopId}'`);
      await tryAgain.click();
      await expect(page.getByRole('heading', { level: 1, name: /E2E Shop/ })).toBeVisible();
    } finally {
      sql(`update "Shop" set plan='${before}' where id='${shopId}'`);
    }
  });

  test('W04 AS-98: when the shop list cannot be read but the shop can, the shell still opens with only the current shop in the switcher @desktop', async ({ page }) => {
    covers('entry.frame.shops-list-fail-soft');
    const member = await register(page);
    const good = await openShopByApi(member, 'Aiqa Soft Good');
    const bad = await openShopByApi(member, 'Aiqa Soft Bad');
    // A second shop whose stored plan the list cannot describe fails the list read, not the read of the good shop.
    const { execFileSync } = await import('node:child_process');
    const sql = (statement: string) => execFileSync('docker', ['exec', '-i', process.env.AIQA_DB_CONTAINER ?? 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', statement]);
    sql(`update "Shop" set plan='AIQA_BROKEN' where id='${bad.shopId}'`);
    try {
      await page.goto(`${HOME}/${good.shopId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Aiqa Soft Good' })).toBeVisible();
      const { sellerMenu } = await import('./helpers');
      const menu = await sellerMenu(page);
      await menu.getByRole('button').first().click();
      await expect(menu.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(1);
      await expect(menu.getByRole('list', { name: 'Your shops' })).toContainText('Aiqa Soft Good');
      await expect(menu.getByRole('link', { name: 'All your shops' })).toHaveAttribute('href', HOME);
    } finally {
      sql(`update "Shop" set plan='STARTER' where id='${bad.shopId}'`);
    }
  });

});
}

// ---- the shell
{
/**
 * AI QA, area "entry", pass 2, section "the dashboard shell" (sidebar at 1024 px and wider, shop bar and drawer below): layout
 * breakpoints, the navigation landmark, the current-page marker, the pending skeleton and the banner region. Each test names the
 * map lines it covers (scripts/aiqa/coverage/entry.tsv) in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';

async function ownerInShop(page: Page) {
  const member = await register(page);
  const shop = await openShopByApi(member);
  return { member, ...shop };
}

/** Holds back every page-data answer (the browser's navigation fetches) of the section until `release()` is called. */
async function holdSection(page: Page, section: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  await page.route(
    (url) => url.pathname.endsWith(section),
    async (route) => {
      if (route.request().headers()['rsc'] === '1') {
        held += 1;
        await gate;
      }
      await route.fallback();
    },
  );
  return { release, held: () => held };
}

test.describe('entry: the shell', () => {
  test('W04 AS-98: from 1024 px a 256 px sidebar and no shop bar; below it the bar and no sidebar (1023 and 1024 exactly) @desktop', async ({ page }) => {
    covers('entry.shell.desktop-layout');
    const { shopId } = await ownerInShop(page);
    const sidebar = page.locator('aside');
    const bar = page.getByRole('region', { name: 'Shop bar' });
    for (const [width, wide] of [[1280, true], [1024, true], [1023, false], [390, false]] as const) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${HOME}/${shopId}`);
      if (wide) {
        await expect(sidebar, `${width}: sidebar`).toBeVisible();
        expect((await sidebar.boundingBox())!.width, `${width}: sidebar width`).toBe(256);
        await expect(bar, `${width}: bar`).toBeHidden();
      } else {
        await expect(bar, `${width}: bar`).toBeVisible();
        await expect(sidebar, `${width}: sidebar`).toBeHidden();
        await expect(bar.getByRole('button', { name: 'Open seller menu' })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}: no sideways scroll`).toBe(true);
    }
  });

  test('W04 AS-98: the menu is one landmark with three headings, the switcher on top, and exactly one current entry @desktop', async ({ page }) => {
    covers('entry.shell.sidebar-switcher', 'entry.shell.nav-landmark', 'entry.shell.nav-account-links', 'entry.shell.nav-current-marker');
    const { shopId, shopName } = await ownerInShop(page);
    await page.goto(`${HOME}/${shopId}`);
    let nav = await sellerNav(page);
    await expect(nav).toBeVisible();
    // The switcher is the first control of the menu and shows the shop.
    const menuRoot = isPhone(page) ? page.getByRole('dialog', { name: 'Seller menu' }) : page.locator('aside');
    await expect(menuRoot.getByRole('button').first()).toHaveText(shopName);
    expect(await menuRoot.locator('button, nav').first().evaluate((node) => node.tagName)).toBe('BUTTON');
    // Headings: Shop, Developers, Account, in that order.
    await expect(nav.getByRole('heading', { level: 2 })).toHaveText(['Shop', 'Developers', 'Account']);
    // Account links for an owner.
    await expect(nav.getByRole('link', { name: 'Your orders' })).toHaveAttribute('href', '/orders');
    await expect(nav.getByRole('link', { name: 'Account security' })).toHaveAttribute('href', '/account/security');

    // Exactly one current entry per place: the overview on the overview, not on its sub-pages.
    const places: [string, string][] = [
      ['', 'Overview'],
      ['/inventory', 'Inventory'],
      ['/orders', 'Orders'],
      ['/developers/api-keys', 'API keys'],
      [`/developers/webhooks/${UNKNOWN_ID}`, 'Webhooks'],
      ['/team?tab=invitations', 'Team'],
    ];
    for (const [section, label] of places) {
      await page.goto(`${HOME}/${shopId}${section}`);
      nav = await sellerNav(page);
      await expect(nav.locator('[aria-current="page"]'), section || 'overview').toHaveCount(1);
      await expect(nav.locator('[aria-current="page"]'), section || 'overview').toHaveText(label);
    }
    // The phone bar names the page.
    if (isPhone(page)) {
      await page.goto(`${HOME}/${shopId}/developers/usage`);
      await expect(page.getByRole('region', { name: 'Shop bar' })).toContainText('Usage');
    }
  });

  test('W04 AS-91, AS-98: a click on another entry shows a skeleton at once and the menu stays; the current entry and modified clicks start none; leaving by Account links leaves no skeleton behind @desktop', async ({ page, context }) => {
    covers('entry.shell.nav-click-pending-skeleton', 'entry.shell.nav-no-pending-leak');
    const { shopId } = await ownerInShop(page);
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    const skeleton = page.locator('#main-content [data-skeleton="list"]');
    const hold = await holdSection(page, '/inventory');

    // A click on the current entry starts nothing.
    let nav = await sellerNav(page);
    await nav.getByRole('link', { name: 'Overview' }).click();
    await expect(skeleton).toHaveCount(0);

    // A ctrl-click (new tab) starts nothing either, whatever the page does.
    if (!isPhone(page)) {
      nav = await sellerNav(page);
      const popup = context.waitForEvent('page');
      await nav.getByRole('link', { name: 'Inventory' }).click({ modifiers: ['Control'] });
      await (await popup).close();
      await expect(skeleton).toHaveCount(0);
    }

    // A plain click: the skeleton shows while the answer is held; the menu entry is still there.
    nav = await sellerNav(page);
    await nav.getByRole('link', { name: 'Inventory' }).click();
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    expect(await skeleton.innerText()).toBe('');
    if (!isPhone(page)) await expect(nav.getByRole('link', { name: 'Inventory' })).toBeVisible();
    expect(hold.held()).toBeGreaterThan(0);

    // Leave the dashboard while the skeleton is still waiting: through the Account links.
    nav = await sellerNav(page);
    await nav.getByRole('link', { name: 'Account security' }).click();
    await expect(page).toHaveURL('/account/security');
    hold.release();
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await expect(skeleton).toHaveCount(0);
    // And the skeleton clears when the page arrives.
    nav = await sellerNav(page);
    await nav.getByRole('link', { name: 'Orders', exact: true }).click();
    await expect(page).toHaveURL(`${HOME}/${shopId}/orders`);
    await expect(skeleton).toHaveCount(0);
  });

  test('W04 AS-88: the banner region is hidden when empty; offline notice comes before the shop status banner @desktop', async ({ page, context }) => {
    covers('entry.shell.mobile-banner-region-order');
    const { shopId } = await ownerInShop(page);
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    const region = page.locator('#main-content div.flex.flex-col.gap-2').filter({ has: page.getByRole('status') }).first();
    // Nothing to say: the region takes no room (no blank gap above the page).
    await expect(region).toBeHidden();

    setShopStatus(shopId, 'SUSPENDED');
    await page.goto(`${HOME}/${shopId}`);
    const banner = page.getByRole('status', { name: 'Shop status' });
    await expect(banner).toContainText('This shop is suspended.');
    await context.setOffline(true);
    const offline = page.getByText("You're offline. Changes can't be saved.");
    await expect(offline).toBeVisible();
    const [o, b] = [await offline.boundingBox(), await banner.boundingBox()];
    expect(o!.y + o!.height, 'offline notice above the status banner').toBeLessThanOrEqual(b!.y + 1);
    await context.setOffline(false);
    await expect(offline).toBeHidden();
    await expect(banner).toBeVisible();
  });

  test('W04 AS-91: a click whose page never arrives gives up after 15 s and shows the old page again @desktop', async ({ page }) => {
    covers('entry.shell.nav-click-pending-skeleton');
    const { shopId } = await ownerInShop(page);
    await page.clock.install();
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    const skeleton = page.locator('#main-content [data-skeleton="list"]');
    const hold = await holdSection(page, '/inventory');
    await (await sellerNav(page)).getByRole('link', { name: 'Inventory', exact: true }).click();
    await expect(skeleton).toBeVisible();
    await page.clock.fastForward(14_000);
    await expect(skeleton).toBeVisible();
    await page.clock.fastForward(2_000);
    await expect(skeleton).toHaveCount(0);
    await expect(page).toHaveURL(`${HOME}/${shopId}`);
    hold.release();
  });
});
}

// ---- the shop bar and drawer
{
/**
 * AI QA, area "entry", pass 3, section "the shop bar and drawer below 1024 px". Every test sets the width itself (390 px), so both
 * projects run the same thing. Each test names the map lines it covers in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const PHONE = { width: 390, height: 844 };

async function phoneOwner(page: Page, name?: string) {
  await page.setViewportSize(PHONE);
  const member = await register(page);
  const shop = await openShopByApi(member, name);
  return { member, ...shop };
}

const bar = (page: Page) => page.getByRole('region', { name: 'Shop bar' });
const drawer = (page: Page) => page.getByRole('dialog', { name: 'Seller menu' });
const opener = (page: Page) => bar(page).getByRole('button', { name: 'Open seller menu' });

async function openDrawer(page: Page) {
  await clickThroughDevOverlay(page);
  await expect(page.getByRole('dialog')).toBeHidden(); // a sheet still sliding out blocks the button
  await opener(page).click();
  await expect(drawer(page)).toBeVisible();
}

test.describe('entry: the shop bar and drawer', () => {
  test('W04 AS-98: the bar shows Open menu (44 px), the shop name and the page name; gone at 1024 px @phone', async ({ page }) => {
    covers('entry.drawer.shop-bar', 'entry.drawer.page-label');
    const { shopId, shopName } = await phoneOwner(page);
    await page.goto(`${HOME}/${shopId}`);
    await expect(bar(page)).toBeVisible();
    const box = (await opener(page).boundingBox())!;
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([44, 44]);
    await expect(bar(page).getByText(shopName, { exact: true })).toBeVisible();
    const labels: [string, string][] = [
      ['', 'Overview'],
      ['/inventory', 'Inventory'],
      ['/orders', 'Orders'],
      ['/team?tab=invitations', 'Team'],
      ['/developers/api-keys', 'API keys'],
      [`/developers/webhooks/${UNKNOWN_ID}`, 'Webhooks'],
      ['/developers/usage', 'Usage'],
      ['/campaigns', 'Campaigns'],
    ];
    for (const [section, label] of labels) {
      await page.goto(`${HOME}/${shopId}${section}`);
      await expect(bar(page).locator('p').nth(1), section || 'overview').toHaveText(label);
    }
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(bar(page)).toBeHidden();
    await page.setViewportSize({ width: 1023, height: 800 });
    await expect(bar(page)).toBeVisible();
  });

  test('W04 AS-98: the sheet has the sidebar content, a description for screen readers, focus inside; the X, Escape and the backdrop close it and focus returns to Open menu @phone', async ({ page }) => {
    covers('entry.drawer.open', 'entry.drawer.description-sr', 'entry.drawer.close-button', 'entry.drawer.escape', 'entry.drawer.outside-click');
    const { shopId, shopName } = await phoneOwner(page);
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await openDrawer(page);
    const sheet = drawer(page);
    const box = (await sheet.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(320);
    expect(box.width).toBeLessThanOrEqual(0.85 * 390 + 1);
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.x)).toBe(0); // after the slide-in
    // Same content as the desktop sidebar: the switcher button, three groups, the same links.
    await expect(sheet.getByRole('button').first()).toHaveText(shopName);
    const mobileLinks = await sheet.getByRole('navigation', { name: 'Seller' }).getByRole('link').evaluateAll((links) => links.map((link) => `${link.textContent}|${link.getAttribute('href')}`));
    // Focus moved inside; the page behind cannot be reached.
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await expect(sheet).toHaveAccessibleDescription('Pages of this shop, developer tools and your account.');
    expect(await page.evaluate(() => document.elementFromPoint(380, 400)?.closest('[role="dialog"]') === null)).toBe(true); // the backdrop, not the page
    // Behind the sheet, for a screen reader: the page content is not in the accessibility tree.
    await expect.soft(page.getByRole('main'), 'page content hidden from screen readers behind the sheet').toHaveCount(0);
    await expect.soft(page.getByRole('region', { name: 'Last 30 days', exact: true })).toHaveCount(0);

    // The desktop sidebar holds the same entries.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 800 });
    const desktopLinks = await page.locator('aside').getByRole('navigation', { name: 'Seller' }).getByRole('link').evaluateAll((links) => links.map((link) => `${link.textContent}|${link.getAttribute('href')}`));
    expect(mobileLinks).toEqual(desktopLinks);
    await page.setViewportSize(PHONE);
    await page.reload();

    // The X.
    await openDrawer(page);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
    await expect(opener(page)).toBeFocused();
    // Escape.
    await openDrawer(page);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(opener(page)).toBeFocused();
    // The dimmed backdrop (right of the 320 px sheet).
    await openDrawer(page);
    await page.mouse.click(380, 600);
    await expect(sheet).toBeHidden();
    await expect(opener(page)).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow !== 'hidden' && !document.body.hasAttribute('data-scroll-locked'))).toBe(true);
  });

  test('W04 AS-98: choosing an entry closes the drawer and shows the page; Back while open closes it; the switcher works inside and closes both @phone', async ({ page }) => {
    covers('entry.drawer.close-on-navigate', 'entry.drawer.switcher-inside');
    const { member, shopId } = await phoneOwner(page);
    const second = await openSecondShop(member, 'Aiqa Second');
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await openDrawer(page);
    await drawer(page).getByRole('link', { name: 'Inventory', exact: true }).click();
    await expect(page).toHaveURL(`${HOME}/${shopId}/inventory`);
    await expect(drawer(page)).toBeHidden();
    await expect(bar(page).locator('p').nth(1)).toHaveText('Inventory');

    // Back while the drawer is open: it closes with the address change.
    await openDrawer(page);
    await page.goBack();
    await expect(page).toHaveURL(`${HOME}/${shopId}`);
    await expect(drawer(page)).toBeHidden();
    await expect(bar(page).locator('p').nth(1)).toHaveText('Overview');

    // The switcher inside the drawer: the list opens within the sheet, choosing closes list and drawer.
    await openDrawer(page);
    await drawer(page).getByRole('button').first().click();
    const list = drawer(page).getByRole('list', { name: 'Your shops' });
    await expect(list).toBeVisible();
    const [lb, db] = [(await list.boundingBox())!, (await drawer(page).boundingBox())!];
    expect(lb.x).toBeGreaterThanOrEqual(db.x);
    expect(lb.x + lb.width).toBeLessThanOrEqual(db.x + db.width + 1);
    await list.getByRole('link').filter({ hasText: 'Aiqa Second' }).click();
    await expect(page).toHaveURL(`${HOME}/${second.shopId}`);
    await expect(drawer(page)).toBeHidden();
    await expect(bar(page).getByText('Aiqa Second', { exact: true })).toBeVisible();
  });

  test('W04 AS-98: an 80-character shop name never scrolls a shell page sideways at 390 px @phone', async ({ page }) => {
    covers('entry.drawer.sideways-scroll');
    const long = `${'W'.repeat(40)} ${'m'.repeat(39)}`;
    const { member, shopId } = await phoneOwner(page, long);
    await openSecondShop(member, `${'Q'.repeat(80)}`);
    const sections = ['', '/inventory', '/orders', '/team', '/developers/api-keys', '/developers/usage', '/campaigns'];
    for (const section of sections) {
      await page.goto(`${HOME}/${shopId}${section}`);
      await expect(bar(page)).toBeVisible();
      expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no sideways scroll on ${section || 'overview'}`).toBe(true);
    }
    await page.goto(`${HOME}/${shopId}`);
    await openDrawer(page);
    await drawer(page).getByRole('button').first().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('W04 AS-98: growing to 1280 px with the drawer open shows the sidebar, closes the drawer and leaves no scroll lock @phone', async ({ page }) => {
    covers('entry.drawer.rotate-resize');
    const { shopId } = await phoneOwner(page);
    await page.goto(`${HOME}/${shopId}`);
    await openDrawer(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('aside')).toBeVisible();
    await expect(bar(page)).toBeHidden();
    // The drawer is hidden or closed, and the page is not locked: the sidebar link works and the page scrolls/clicks.
    await expect(drawer(page)).toBeHidden();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden' && !document.body.hasAttribute('data-scroll-locked'))).toBe(true);
    await page.locator('aside').getByRole('link', { name: 'Inventory', exact: true }).click();
    await expect(page).toHaveURL(`${HOME}/${shopId}/inventory`);
  });
});
}

// ---- the shop status banner
{
/**
 * AI QA, area "entry", pass 3, section "the shop status banner": suspended and closing shops, the disabled write controls, the API
 * refusals, the admin suspend/reinstate rows (Shop, ShopStatusHistory, Outbox) and the owner's offboarding. Each test names the map
 * lines it covers in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const SUSPENDED = 'This shop is suspended. You can view data but not make changes.';
const CLOSING = 'This shop is being closed. You can view data but not make changes.';
const PAGES = ['', '/inventory', '/orders', '/team', '/developers/usage', '/campaigns'];

async function ownerShop(page: Page) {
  const member = await register(page);
  const shop = await openShopByApi(member);
  const slug = scalar(`select slug from "Shop" where id='${shop.shopId}'`);
  return { member, slug, ...shop };
}

async function adminToken(): Promise<string> {
  const login = await sellerCall('POST', '/api/auth/login', { email: SEED.admin, password: SEED.password });
  expect(login.status).toBe(200);
  return login.data.accessToken.token as string;
}

const banner = (page: Page) => page.getByRole('status', { name: 'Shop status' });

test.describe('entry: the shop status banner', () => {
  test('W04 AS-86: no banner and no gap on an active shop; the stored status gives the words on every page @desktop', async ({ page }) => {
    covers('entry.banner.active-none', 'entry.banner.suspended', 'entry.banner.closing');
    const { shopId } = await ownerShop(page);
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    // The banner region has no height of its own: the first thing in the content starts at the content top.
    const gap = await page.evaluate(() => {
      const main = document.querySelector('#main-content')!;
      const region = [...main.querySelectorAll('div')].find((d) => d.className.includes('empty:hidden') && d.className.includes('flex-col'));
      return region ? region.getBoundingClientRect().height : 0;
    });
    expect(gap).toBe(0);

    for (const [status, words] of [['SUSPENDED', SUSPENDED], ['DELETING', CLOSING]] as const) {
      setShopStatus(shopId, status);
      expect(scalar(`select status from "Shop" where id='${shopId}'`)).toBe(status);
      for (const section of PAGES) {
        await page.goto(`${HOME}/${shopId}${section}`);
        const b = banner(page);
        await expect(b, `${status} ${section || 'overview'}`).toHaveText(words);
        await expect(b).toHaveAttribute('role', 'status');
        // Above the page body: its bottom is above the page heading.
        const [bb, hb] = [(await b.boundingBox())!, (await page.locator('#main-content h1').first().boundingBox())!];
        expect(bb.y + bb.height, `${section || 'overview'}: banner above heading`).toBeLessThanOrEqual(hb.y + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
    }
    setShopStatus(shopId, 'ACTIVE');
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test('W04 AS-86: a status that is neither active nor suspended reads as closing @desktop', async ({ page }) => {
    covers('entry.banner.deleted-status');
    const { shopId } = await ownerShop(page);
    // DELETED is the only other value the screens know; the shop frame treats it as not found (see entry.frame.deleted-shop), so the
    // closing words for it can only be reached with a status the database accepts as text.
    setShopStatus(shopId, 'DELETED');
    await page.goto(`${HOME}/${shopId}`);
    await expect(banner(page)).toHaveCount(0);
    await expect(page.getByText("We couldn't find that shop.").first()).toBeVisible();
  });

  test('W04 AS-86: on a suspended or closing shop the write controls are disabled with the banner words, and the API refuses writes (403 shop_suspended, 409 shop_offboarding) but still reads @desktop', async ({ page }) => {
    covers('entry.banner.writes-disabled');
    const { member, shopId } = await ownerShop(page);
    const token = await tokenOf(member);
    const controls: [string, string][] = [
      ['/inventory', 'Add product'],
      ['/developers/api-keys', 'Create key'],
      ['/developers/webhooks', 'Add endpoint'],
      ['/imports', 'Start import'],
      ['/exports', 'Start export'],
      ['/widget', 'Add site'],
      ['/knowledge', 'Add document'],
      ['/campaigns', 'Create campaign'],
      ['/team?tab=invitations', 'Send invitation'],
    ];
    for (const [status, words, code, http] of [['SUSPENDED', SUSPENDED, 'shop_suspended', 403], ['DELETING', CLOSING, 'shop_offboarding', 409]] as const) {
      setShopStatus(shopId, status);
      for (const [section, name] of controls) {
        await page.goto(`${HOME}/${shopId}${section}`);
        const control = page.getByRole('button', { name, exact: true }).first();
        await expect.soft(control, `${status}: ${name} disabled`).toBeDisabled();
        const description = await control.evaluate((node) => {
          const ids = (node.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
          return [node.getAttribute('title') ?? '', ...ids.map((id) => document.getElementById(id)?.textContent ?? ''), (node as HTMLButtonElement).form?.textContent ?? ''].join(' | ');
        });
        expect.soft(description, `${status}: ${name} carries the words`).toContain(words);
      }
      // The API: a write is refused with the code, a read still works.
      const refused = await sellerCall('POST', `/api/shops/${shopId}/invites`, { email: uniqueEmail('nobody'), role: 'VIEWER' }, token);
      expect([refused.status, refused.data?.code ?? refused.data?.error?.code], `${status} write`).toEqual([http, code]);
      const renamed = await sellerCall('PATCH', `/api/shops/${shopId}`, { name: 'Renamed Under Status' }, token);
      expect([renamed.status, renamed.data?.code]).toEqual([http, code]);
      expect((await sellerCall('GET', `/api/shops/${shopId}`, undefined, token)).status).toBe(200);
      expect((await sellerCall('GET', `/api/shops/${shopId}/members`, undefined, token)).status).toBe(200);
      expect(scalar(`select name from "Shop" where id='${shopId}'`)).not.toBe('Renamed Under Status');
    }
  });

  test('W04 AS-86: a refused write (403 shop_suspended) brings the banner without a reload; the next page load shows the new status @desktop', async ({ page }) => {
    covers('entry.banner.refresh-after-status-change');
    const { shopId } = await ownerShop(page);
    await page.goto(`${HOME}/${shopId}/team?tab=invitations`);
    const form = page.getByRole('button', { name: 'Send invitation' });
    await expect(form).toBeEnabled();
    await expect(banner(page)).toHaveCount(0);
    // The status changes behind the page's back.
    const admin = await adminToken();
    const suspended = await sellerCall('POST', `/api/admin/shops/${shopId}/suspend`, { reason: 'aiqa refresh check' }, admin);
    expect(suspended.status).toBe(200);
    await expect(banner(page), 'nothing changes by itself').toHaveCount(0);
    await page.getByLabel('E-mail address').fill(uniqueEmail('late'));
    await form.click();
    await expect(page.getByText(SUSPENDED).first()).toBeVisible();
    await expect.soft(banner(page), 'the refetch of the shop data brings the banner').toHaveText(SUSPENDED);
    await expect.soft(form, 'the write control is disabled after the refetch').toBeDisabled();
    // And back: reinstated, next navigation clears it.
    expect((await sellerCall('POST', `/api/admin/shops/${shopId}/reinstate`, { reason: 'aiqa refresh check' }, admin)).status).toBe(200);
    await page.goto(`${HOME}/${shopId}/team?tab=invitations`);
    await expect(banner(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send invitation' })).toBeEnabled();
  });

  test('W04 AS-86: the admin suspend and reinstate, and the owner offboarding, write Shop, ShopStatusHistory and Outbox rows @desktop', async ({ page }) => {
    covers('entry.banner.admin-suspend-db', 'entry.banner.offboarding-start-db');
    const { member, shopId, slug } = await ownerShop(page);
    const token = await tokenOf(member);
    const admin = await adminToken();
    const history = () => rows(`select "from", "to", actor, reason from "ShopStatusHistory" where "shopId"='${shopId}' order by at, id`);
    const events = () => rows(`select "eventName", payload->'payload'->>'from', payload->'payload'->>'to' from "Outbox" where "aggregateId"='${shopId}' and "eventName"='tenancy.shop_status_changed' order by "createdAt", id`);
    const baseline = history().length;

    // A member cannot use the admin route; an admin can.
    expect((await sellerCall('POST', `/api/admin/shops/${shopId}/suspend`, { reason: 'nope' }, token)).status).toBeGreaterThanOrEqual(401);
    expect(scalar(`select status from "Shop" where id='${shopId}'`)).toBe('ACTIVE');
    const suspend = await sellerCall('POST', `/api/admin/shops/${shopId}/suspend`, { reason: 'aiqa suspend reason' }, admin);
    expect(suspend.status, JSON.stringify(suspend.data)).toBe(200);
    expect(scalar(`select status from "Shop" where id='${shopId}'`)).toBe('SUSPENDED');
    const adminId = userId(SEED.admin);
    const afterSuspend = history();
    expect(afterSuspend).toHaveLength(baseline + 1);
    expect(afterSuspend.at(-1)).toEqual(['ACTIVE', 'SUSPENDED', adminId, 'aiqa suspend reason']);
    expect(events().at(-1)).toEqual(['tenancy.shop_status_changed', 'ACTIVE', 'SUSPENDED']);
    // The member's dashboard shows it.
    await page.goto(`${HOME}/${shopId}`);
    await expect(banner(page)).toHaveText(SUSPENDED);

    const reinstate = await sellerCall('POST', `/api/admin/shops/${shopId}/reinstate`, { reason: 'aiqa reinstate reason' }, admin);
    expect(reinstate.status).toBe(200);
    expect(scalar(`select status from "Shop" where id='${shopId}'`)).toBe('ACTIVE');
    expect(history().at(-1)).toEqual(['SUSPENDED', 'ACTIVE', adminId, 'aiqa reinstate reason']);
    expect(events().at(-1)).toEqual(['tenancy.shop_status_changed', 'SUSPENDED', 'ACTIVE']);
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);

    // Offboarding: wrong confirmation refused; right one sets DELETING and purgeAt; cancel returns ACTIVE.
    const wrong = await sellerCall('POST', `/api/shops/${shopId}/offboarding`, { confirmSlug: `${slug}-x` }, token);
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(scalar(`select status from "Shop" where id='${shopId}'`)).toBe('ACTIVE');
    const started = await sellerCall('POST', `/api/shops/${shopId}/offboarding`, { confirmSlug: slug }, token);
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    const [status, purge] = rows(`select status, "purgeAt" is not null from "Shop" where id='${shopId}'`)[0]!;
    expect([status, purge]).toEqual(['DELETING', 't']);
    expect(rows(`select count(*) from "Outbox" where "aggregateId"='${shopId}' and "eventName"='tenancy.shop_offboarding_started'`)[0]![0]).toBe('1');
    await page.goto(`${HOME}/${shopId}`);
    await expect(banner(page)).toHaveText(CLOSING);
    const cancelled = await sellerCall('DELETE', `/api/shops/${shopId}/offboarding`, undefined, token);
    expect(cancelled.status, JSON.stringify(cancelled.data)).toBe(200);
    expect(rows(`select status, "purgeAt" is null from "Shop" where id='${shopId}'`)[0]).toEqual(['ACTIVE', 't']);
    expect(rows(`select count(*) from "Outbox" where "aggregateId"='${shopId}' and "eventName"='tenancy.shop_offboarding_cancelled'`)[0]![0]).toBe('1');
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });
});
}

// ---- offline
{
/**
 * AI QA, area "entry", pass 3, section "the offline notice": the shell's "Changes can't be saved" banner, the one refetch when the
 * browser is back, a write while offline, and the pages outside the shell. Each test names the map lines it covers in its title and
 * in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const SHELL_OFFLINE = "You're offline. Changes can't be saved.";
const SITE_OFFLINE = "You're offline. Some things may not load or save until you're back online.";

test.describe('entry: offline', () => {
  test('W04 AS-88: the notice shows above the page when offline, clears when back, and the open lists refetch exactly once @desktop', async ({ page, context }) => {
    covers('entry.offline.banner-show', 'entry.offline.banner-clear-refetch', 'entry.offline.no-refetch-when-never-offline');
    const member = await register(page);
    const { shopId } = await openShopByApi(member);
    const watch = watchApi(page);
    await page.goto(`${HOME}/${shopId}/inventory`);
    await expect(page.getByRole('heading', { name: /Inventory/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add product' }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    const notice = page.getByText(SHELL_OFFLINE, { exact: true });

    // Never offline: the page's reads happened once each, and nothing repeats while we wait.
    const reads = () => watch.seen.filter((s) => s.method === 'GET' && /\/api\/bff\/shops\/|\/api\/shops\//.test(s.path)).map((s) => s.path);
    const first = reads();
    expect(first.length).toBeGreaterThan(0);
    await page.waitForTimeout(3000); // nothing to wait for: proves no further request comes by itself
    expect(reads(), 'no extra refetch while online').toEqual(first);
    await expect(notice).toHaveCount(0);
    // The status region is always mounted, empty and taking no room.
    const regions = page.locator('#main-content [role="status"]');
    expect(await regions.count()).toBeGreaterThan(0);

    // Offline: the notice is above the heading, inside the screen.
    await context.setOffline(true);
    await expect(notice).toBeVisible();
    await expect(notice).toBeVisible();
    const [nb, hb] = [(await notice.boundingBox())!, (await page.locator('#main-content h1').first().boundingBox())!];
    expect(nb.y + nb.height).toBeLessThanOrEqual(hb.y + 1);
    expect(nb.x).toBeGreaterThanOrEqual(0);
    expect(nb.x + nb.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await notice.evaluate((node) => node.closest('[role="status"]') !== null)).toBe(true);
    await page.waitForTimeout(1000);
    expect(reads(), 'nothing is fetched while offline').toEqual(first);

    // Back online: the notice clears and the lists on screen refetch exactly once.
    watch.reset();
    await context.setOffline(false);
    await expect(notice).toHaveCount(0);
    await expect.poll(() => reads().length, { message: 'the open queries refetch' }).toBeGreaterThan(0);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    const again = reads();
    // Each open query once (AS-88: "open queries refetch once").
    const counts = new Map<string, number>();
    for (const path of again) counts.set(path, (counts.get(path) ?? 0) + 1);
    for (const [path, n] of counts) expect.soft(n, `refetches of ${path}`).toBe(1);
    // A second offline period refetches once more, once.
    watch.reset();
    await context.setOffline(true);
    await expect(notice).toBeVisible();
    await context.setOffline(false);
    await expect(notice).toHaveCount(0);
    await expect.poll(() => reads().length).toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    expect.soft(reads().length, 'second offline period: one refetch each').toBeLessThanOrEqual(counts.size);
  });

  test('W04 AS-88: a write while offline says the server could not be reached and keeps what was typed @desktop', async ({ page, context }) => {
    covers('entry.offline.write-while-offline');
    const member = await register(page);
    const { shopId } = await openShopByApi(member);
    await page.goto(`${HOME}/${shopId}/team?tab=invitations`);
    const email = uniqueEmail('offline');
    await page.getByLabel('E-mail address').fill(email);
    await page.getByLabel('Role', { exact: true }).selectOption('Staff');
    const watch = watchApi(page);
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText("Couldn't reach the server. Check your connection and try again.")).toBeVisible();
    await expect(page.getByLabel('E-mail address')).toHaveValue(email);
    await expect(page.getByLabel('Role', { exact: true })).toHaveValue('STAFF');
    await expect(page.getByRole('button', { name: 'Send invitation' })).toBeEnabled();
    expect(watch.seen.filter((s) => s.method === 'POST' && s.status !== null && s.status < 400)).toEqual([]);
    // Back online, the same form sends it once.
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText("Couldn't reach the server")).toHaveCount(0);
    await expect.poll(() => watch.seen.filter((s) => s.method === 'POST' && s.status === 201).length).toBe(1);
  });

  test('W04 AS-88: the open-shop form and the picker (outside the shell) carry the site notice but not the shell notice @desktop', async ({ page, context }) => {
    covers('entry.offline.on-no-shop-page');
    const member = await register(page);
    await page.goto(HOME);
    await expect(page.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText(SITE_OFFLINE)).toBeVisible();
    await expect(page.getByText(SHELL_OFFLINE, { exact: true })).toHaveCount(0);
    await context.setOffline(false);
    await expect(page.getByText(SITE_OFFLINE)).toHaveCount(0);
    // The picker: a member with two shops.
    await openShopByApi(member);
    await openShopByApi(member);
    await page.goto(HOME);
    await expect(page.getByRole('heading', { level: 1, name: 'Your shops' })).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText(SITE_OFFLINE)).toBeVisible();
    await expect(page.getByText(SHELL_OFFLINE, { exact: true })).toHaveCount(0);
    await context.setOffline(false);
  });
});
}

// ---- sign-in, header, keyboard, odd addresses
{
/**
 * AI QA, area "entry", pass 3, section "sign-in return, the header way in, keyboard, dark mode, odd addresses" and the UI side of two
 * API lines. Each test names the map lines it covers in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const NOT_FOUND = "We couldn't find that shop.";

async function signInForm(page: Page, email: string, returnTo: string) {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await waitForForm(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(NEW_USER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function ownerShop(page: Page) {
  const member = await register(page);
  return { member, ...(await openShopByApi(member)) };
}

test.describe('entry: sign-in, header, keyboard, odd addresses', () => {
  test('W04 AS-84: a signed-out visit to a deep link returns to that link after sign-in, with the query; the two-step code step keeps it too @desktop', async ({ page }) => {
    covers('entry.auth.login-return');
    const { member, shopId } = await ownerShop(page);
    await page.context().clearCookies();
    // 1. The real route a person takes: the deep link first, the sign-in form after.
    const target = `${HOME}/${shopId}/orders?status=PAID&page=2`;
    await page.goto(target);
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    const returnTo = new URL(page.url()).searchParams.get('returnTo');
    await signInForm(page, member.email, returnTo!);
    await expect.soft(page, 'back on the link that was typed').toHaveURL(target);

    // 2. The two-step code step keeps the address: turn it on, sign out, sign in with a code.
    await page.goto('/account/security');
    await page.getByRole('button', { name: 'Set up' }).click();
    const setup = page.getByRole('dialog', { name: 'Set up two-step verification' });
    const key = (await setup.locator('code').innerText()).trim();
    await setup.getByRole('button', { name: 'Next' }).click();
    await setup.getByLabel('6-digit code').fill(totp(key));
    await setup.getByRole('button', { name: 'Confirm' }).click();
    const codes = page.getByRole('dialog', { name: 'Save your recovery codes' });
    await codes.getByRole('checkbox', { name: "I've saved these codes" }).click();
    await codes.getByRole('button', { name: 'Done' }).click();
    await page.context().clearCookies();
    const deep = `${HOME}/${shopId}/orders?status=PAID&status=SHIPPED`;
    await signInForm(page, member.email, deep);
    await expect(page).toHaveURL(/\/login\/mfa/);
    await waitForForm(page);
    await page.getByLabel('Authentication code').fill(totp(key, Date.now() + 30_000));
    await page.getByRole('button', { name: /Verify|Sign in|Continue/ }).click();
    await expect(page).toHaveURL(deep);
  });

  test('W04 AS-84, AS-87: a 401 on parallel seller requests runs the session end once; a cleared cookie and a click on the menu goes to sign-in with no page flash @desktop', async ({ page }) => {
    covers('entry.auth.session-ended-once', 'entry.auth.expired-cookie-on-navigation');
    const { shopId } = await ownerShop(page);
    await page.goto(`${HOME}/${shopId}/inventory`);
    await expect(page.getByRole('heading', { name: /Inventory/ }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    // The session is gone on the server side (cookies removed); going offline and back online refetches the open lists together,
    // and every one of them is refused with a real 401.
    let refused = 0;
    page.on('response', (response) => {
      if (response.status() === 401 && /\/api\/(bff\/)?shops\//.test(response.url())) refused += 1;
    });
    await page.context().clearCookies();
    const ends: string[] = [];
    page.on('framenavigated', (frame) => frame === page.mainFrame() && /\/login/.test(frame.url()) && ends.push(frame.url()));
    const watch = watchApi(page);
    await page.context().setOffline(true);
    await expect(page.getByText("You're offline. Changes can't be saved.", { exact: true })).toBeVisible();
    await page.context().setOffline(false);
    await expect(page).toHaveURL(/\/login/);
    expect(refused, 'more than one request failed together').toBeGreaterThan(1);
    expect(ends, 'one trip to the sign-in page').toHaveLength(1);
    await page.waitForTimeout(1500);
    expect(ends, 'still one trip').toHaveLength(1);
    expect(new URL(page.url()).searchParams.get('returnTo') ?? '').toContain(shopId);

    // The cookie is gone and the person clicks a menu entry: sign-in with the returnTo of that page, no page flash.
    const second = await ownerShop(page);
    await page.goto(`${HOME}/${second.shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await page.context().clearCookies();
    const flashed: string[] = [];
    page.on('response', async (response) => {
      if (/\/inventory/.test(response.url()) && response.request().resourceType() === 'document') flashed.push(await response.text().catch(() => ''));
    });
    await (await sellerNav(page)).getByRole('link', { name: 'Inventory', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    expect.soft(new URL(page.url()).searchParams.get('returnTo'), 'the clicked page').toBe(`${HOME}/${second.shopId}/inventory`);
    await expect(page.getByRole('heading', { name: /Inventory/ })).toHaveCount(0);
    expect(flashed.join('')).not.toContain('Add product');
  });

  test('W04 AS-98: signed in, the account menu offers Dashboard to /dashboard and it ends on the shop; signed out there is no such link @desktop', async ({ page }) => {
    covers('entry.misc.header-link');
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toHaveCount(0);
    const { shopId } = await ownerShop(page);
    await page.goto('/');
    if (isPhone(page)) await page.getByRole('button', { name: 'Open menu' }).click();
    else await page.getByRole('button', { name: /Account|account menu|@/i }).first().click();
    const link = page.getByRole('menuitem', { name: 'Dashboard' }).or(page.getByRole('link', { name: 'Dashboard', exact: true })).first();
    await expect(link).toHaveAttribute('href', '/dashboard');
    await link.click();
    await expect(page).toHaveURL(`${HOME}/${shopId}`);
  });

  test('W04 AS-98: every shell page has one h1; a client navigation updates the title announced to screen readers and does not leave focus on a removed element @desktop', async ({ page }) => {
    covers('entry.misc.title-focus-on-navigation');
    const { shopId } = await ownerShop(page);
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    const titles = new Map<string, string>();
    for (const [section, label] of [['', 'Overview'], ['/inventory', 'Inventory'], ['/orders', 'Orders'], ['/team', 'Team'], ['/developers/usage', 'Usage'], ['/developers/logs', 'Request logs'], ['/campaigns', 'Campaigns'], ['/knowledge', 'Help documents'], ['/payouts', 'Payouts']] as const) {
      await page.goto(`${HOME}/${shopId}${section}`);
      await expect(page.locator('#main-content h1'), `${section || 'overview'}: one page heading`).toHaveCount(1);
      titles.set(label, await page.title());
    }
    // Each page needs a title of its own (the tab and the history say where you are).
    expect.soft(new Set(titles.values()).size, `page titles: ${JSON.stringify([...titles])}`).toBe(titles.size);
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await (await sellerNav(page)).getByRole('link', { name: 'Inventory', exact: true }).click();
    await expect(page).toHaveURL(`${HOME}/${shopId}/inventory`);
    // Focus is not lost: it is on a real element inside the page (not the body).
    expect(await page.evaluate(() => document.activeElement?.isConnected === true && document.activeElement !== document.body)).toBe(true);
    // Screen readers are told about the new page (Next's route announcer).
    await expect.poll(() => page.evaluate(() => document.querySelector('next-route-announcer')?.shadowRoot?.textContent ?? ''), { message: 'route announcement' }).toMatch(/Inventory/);
    await expect(page.locator('#main-content h1')).toHaveText(/Inventory/);
  });

  test('W04 AS-98: the banners read well in dark mode (text against background at least 4.5 : 1) @desktop', async ({ page, context }) => {
    covers('entry.misc.dark-mode');
    await page.emulateMedia({ colorScheme: 'dark' });
    const { shopId } = await ownerShop(page);
    setShopStatus(shopId, 'SUSPENDED');
    await page.goto(`${HOME}/${shopId}`);
    const banner = page.getByRole('status', { name: 'Shop status' });
    await expect(banner).toBeVisible();
    await context.setOffline(true);
    const offline = page.getByText("You're offline. Changes can't be saved.", { exact: true });
    await expect(offline).toBeVisible();
    const ratio = (node: Element) => {
      // Any colour syntax (lab, oklab, rgb) is turned into red/green/blue/alpha by drawing one pixel.
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const g = canvas.getContext('2d', { willReadFrequently: true })!;
      const parse = (css: string) => {
        g.clearRect(0, 0, 1, 1);
        g.fillStyle = '#000';
        g.fillStyle = css;
        g.fillRect(0, 0, 1, 1);
        const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data;
        return [r!, gr!, b!, a! / 255];
      };
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
        return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
      };
      let bg: number[] = [0, 0, 0, 0];
      for (let el: Element | null = node; el; el = el.parentElement) {
        const c = parse(getComputedStyle(el).backgroundColor);
        if ((c[3] ?? 1) > 0) {
          bg = c;
          break;
        }
      }
      // the page behind a translucent colour
      const page = parse(getComputedStyle(document.body).backgroundColor);
      const alpha = bg[3] ?? 1;
      const mixed = [0, 1, 2].map((i) => bg[i]! * alpha + page[i]! * (1 - alpha));
      const [a, b] = [lum(parse(getComputedStyle(node).color)), lum(mixed)];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    expect(await banner.evaluate(ratio), 'status banner contrast').toBeGreaterThanOrEqual(4.5);
    expect(await offline.evaluate(ratio), 'offline notice contrast').toBeGreaterThanOrEqual(4.5);
    expect(await banner.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe('rgb(255, 251, 235)'); // not the light amber
    await context.setOffline(false);
  });

  test('W04 AS-98: Tab reaches every sidebar link with a visible focus ring, and after the last one focus moves into the page @desktop', async ({ page }) => {
    covers('entry.misc.keyboard-skip');
    const { shopId } = await ownerShop(page);
    await page.goto(`${HOME}/${shopId}`);
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    const nav = await sellerNav(page);
    const hrefs = await nav.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    await page.locator('aside').getByRole('button').first().focus();
    const seen: string[] = [];
    const rings: boolean[] = [];
    for (let i = 0; i < hrefs.length; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const style = getComputedStyle(el);
        return { href: el.getAttribute('href'), inSidebar: !!el.closest('aside'), ring: style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) };
      });
      seen.push(info.href ?? '');
      rings.push(info.ring);
      expect(info.inSidebar).toBe(true);
    }
    expect(seen).toEqual(hrefs);
    expect(rings.every(Boolean), `focus ring on every link: ${JSON.stringify(rings)}`).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => ({ inSidebar: !!document.activeElement?.closest('aside'), inContent: !!document.activeElement?.closest('#main-content') }))).toEqual({ inSidebar: false, inContent: true });
  });

  test('W04 AS-98: Your orders and Account security leave the dashboard and Back returns to the same page @desktop', async ({ page }) => {
    covers('entry.misc.unmounted-shell-account-links');
    const { shopId } = await ownerShop(page);
    const start = `${HOME}/${shopId}/inventory`;
    await page.goto(start);
    await expect(page.getByRole('heading', { name: /Inventory/ }).first()).toBeVisible();
    for (const [name, url] of [['Your orders', '/orders'], ['Account security', '/account/security']] as const) {
      await (await sellerNav(page)).getByRole('link', { name }).click();
      await expect(page).toHaveURL(url);
      await expect(page.getByRole('navigation', { name: 'Seller' })).toHaveCount(0);
      await page.goBack();
      await expect(page).toHaveURL(start);
      await expect(page.getByRole('heading', { name: /Inventory/ }).first()).toBeVisible();
      // The menu that was used to leave must not come back open on top of the page.
      const sheet = page.getByRole('dialog', { name: 'Seller menu' });
      await expect.soft(sheet, `${name}: menu closed after Back`).toBeHidden();
      if (await sheet.isVisible()) await page.keyboard.press('Escape');
      await expect((await sellerNav(page)).locator('[aria-current="page"]')).toHaveText('Inventory');
      if (isPhone(page)) await page.keyboard.press('Escape');
    }
  });

  test('W04 AS-85, AS-98: broken addresses give the one not-found page and never a 500; a trailing slash keeps the current marker; a malformed id equals an unknown id @desktop', async ({ page }) => {
    covers('entry.misc.invalid-percent-path', 'entry.misc.trailing-slash', 'entry.form.api-unknown-shop-id');
    const { member, shopId } = await ownerShop(page);
    const token = await tokenOf(member);
    const texts: string[] = [];
    for (const path of ['/%E0%A4%A', `/${shopId}%00`, '/not-a-uuid', `/${UNKNOWN_ID}`, `/%E0%A4%A/inventory`]) {
      const response = await page.goto(`${HOME}${path}`);
      expect(response!.status(), path).toBeLessThan(500);
      await expect.soft(page.getByText(NOT_FOUND).first(), `${path}: the one not-found page`).toBeVisible();
      if (await page.locator('#main-content').count()) texts.push(await mainText(page));
    }
    expect(new Set(texts).size, 'one text for the pages that reach the app').toBe(1);
    // The same on the API side: malformed and unknown ids give one answer.
    const [malformed, unknown] = [await sellerCall('GET', '/api/shops/not-a-uuid', undefined, token), await sellerCall('GET', `/api/shops/${UNKNOWN_ID}`, undefined, token)];
    expect([malformed.status, malformed.data.code]).toEqual([404, 'shop_not_found']);
    const bare = ({ instance, requestId, traceId, ...rest }: Record<string, unknown>) => (void [instance, requestId, traceId], rest);
    expect(bare(malformed.data)).toEqual(bare(unknown.data));
    // Trailing slash.
    for (const [path, label] of [['/', 'Overview'], ['/inventory/', 'Inventory'], ['/developers/usage/', 'Usage']] as const) {
      await page.goto(`${HOME}/${shopId}${path}`);
      await expect(page.getByText(NOT_FOUND)).toHaveCount(0);
      await expect((await sellerNav(page)).locator('[aria-current="page"]'), path).toHaveText(label);
    }
  });

  test('W04 AS-100: a one-letter and an 81-letter shop name are stopped by the form before any request; the same bodies sent by hand are refused by the API; nothing is saved @desktop', async ({ page }) => {
    covers('entry.form.api-name-limits');
    const member = await register(page);
    await page.goto(HOME);
    await expect(page.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
    const watch = watchApi(page);
    const before = scalar(`select count(*) from "Shop" where slug like 'aiqa-lim-%' or name like 'Aiqa Lim%'`);
    // One letter: the form says why and sends nothing.
    await page.getByLabel('Shop name').fill('a');
    await page.getByLabel('Handle').fill(`aiqa-lim-${Date.now().toString(36)}`);
    await page.getByRole('button', { name: 'Open shop' }).click();
    await expect(page.getByText('Enter a shop name of 2 to 80 characters.')).toBeVisible();
    await expect(page).toHaveURL(HOME);
    // 81 letters typed: the box takes 80 and stops (a person cannot send 81).
    await page.getByLabel('Shop name').clear();
    await page.getByLabel('Shop name').pressSequentially('x'.repeat(81));
    expect((await page.getByLabel('Shop name').inputValue()).length).toBe(80);
    expect(watch.writes().filter((w) => /\/api\/(bff\/)?shops$/.test(w.path))).toEqual([]);
    expect(scalar(`select count(*) from "ShopMembership" m join "User" u on u.id=m."userId" where u.email='${member.email}'`)).toBe('0');
    // By hand with the page's own session.
    for (const body of [{ name: 'a', slug: 'aiqa-lim-one' }, { name: 'x'.repeat(81), slug: 'aiqa-lim-many' }, { slug: 'aiqa-lim-noname' }, { name: 'Aiqa Lim ok' }, { name: 'Aiqa Lim ok', slug: 'aiqa-lim-extra', owner: 'x' }]) {
      const result = await forced(page, 'POST', '/api/shops', body);
      expect([result.status, result.json?.code], JSON.stringify(body).slice(0, 50)).toEqual([400, 'validation_failed']);
    }
    expect(scalar(`select count(*) from "Shop" where slug like 'aiqa-lim-%' or name like 'Aiqa Lim%'`)).toBe(before);
    expect(rows(`select count(*) from "ShopMembership" m join "User" u on u.id=m."userId" where u.email='${member.email}'`)[0]![0]).toBe('0');
  });
});
}
