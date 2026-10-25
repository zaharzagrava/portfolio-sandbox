import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { NEW_USER_PASSWORD, register, sellerCall, uniqueEmail, waitForForm } from '../../helpers';
import { UNKNOWN_ID, watchApi } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { rows, scalar, setShopStatus, userId } from '../support/db';
import { covers, ownerByApi } from './support';

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
  test('entry.frame.signed-out-shop-url entry.frame.returnto-nested-path-only entry.frame.401-on-shop-read: a signed-out visit to a section keeps the section and the query, and after sign-in the browser returns there', async ({ page }) => {
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

  test('entry.frame.returnto-keeps-query: repeated query parameters stay repeated and encoded; unsafe return addresses fall back to the home page after sign-in', async ({ page }) => {
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

  test('entry.frame.malformed-shop-id entry.frame.unknown-shop-id entry.frame.foreign-shop-id entry.frame.deleted-shop entry.frame.not-found-page entry.frame.not-found-no-shell: every shop that is not yours is the same page, with no hint, no shell and no call for a malformed id', async ({ page }) => {
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
    expect.soft(answers[0]![0], 'the not-found page answers with the status 404').toBe(404);

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

  test('entry.frame.loading-skeleton entry.frame.page-loading-skeleton entry.frame.title-noindex: the page streams a text-free skeleton first, the title and robots are set, and nothing is cached', async ({ page }) => {
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

  test('entry.frame.hydration-seed: the shop and the shop list come with the page; the browser asks for neither on first paint', async ({ page }) => {
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

  test('entry.frame.shop-5xx entry.frame.error-try-again: a shop whose answer cannot be read shows the error page inside the shell area with a reference, and Try again works', async ({ page }) => {
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

  test('entry.frame.shops-list-fail-soft: when the shop list cannot be read but the shop can, the shell still opens with only the current shop in the switcher', async ({ page }) => {
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
      const { sellerMenu } = await import('../../helpers');
      const menu = await sellerMenu(page);
      await menu.getByRole('button').first().click();
      await expect(menu.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(1);
      await expect(menu.getByRole('list', { name: 'Your shops' })).toContainText('Aiqa Soft Good');
      await expect(menu.getByRole('link', { name: 'All your shops' })).toHaveAttribute('href', HOME);
    } finally {
      sql(`update "Shop" set plan='STARTER' where id='${bad.shopId}'`);
    }
  });

  test.fixme('entry.frame.401-on-shop-read entry.frame.403-as-404: the shop read answers 401 or 403', async () => {
    covers('entry.frame.401-on-shop-read', 'entry.frame.403-as-404');
    // The read is made by the web server after it has checked the session; the browser cannot answer it, a session that dies in
    // between cannot be timed, and the API answers 404 (never 403) for a foreign shop. Not automatable without changing the stack.
  });
});
