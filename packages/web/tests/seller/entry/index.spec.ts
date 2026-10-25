import { expect, test, type Page } from '@playwright/test';
import { NEW_USER_PASSWORD, register, sellerCall, uniqueEmail } from '../../helpers';
import { myShops, openSecondShop, tokenOf, watchApi } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { scalar, setShopStatus, userId } from '../support/db';

/**
 * AI QA, area "entry", section "/dashboard/seller": what a member sees at the front door of the seller dashboard
 * (no shop, one shop, several shops, cursors, legacy addresses, signed-out visitors). Each test names the map lines it covers
 * (scripts/aiqa/coverage/entry.tsv) in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';

function covers(...lines: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: lines.join(',') });
}

/** A signed-in member without any shop. */
async function memberWithoutShop(page: Page) {
  const member = await register(page);
  return member;
}

test.describe('entry: the front door', () => {
  test('entry.index.no-shop-form entry.startnav.* entry.index.title-noindex: a member without a shop gets the form and the Start selling menu', async ({ page }) => {
    covers('entry.index.no-shop-form', 'entry.startnav.start-selling-link', 'entry.startnav.no-account-links', 'entry.index.title-noindex');
    const member = await memberWithoutShop(page);
    await page.goto(HOME);

    await expect(page.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
    await expect(page).toHaveTitle(/^Your shops/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');

    // The left menu holds one entry, marked as the current page, and no account links or shop switcher.
    const menu = page.getByRole('navigation', { name: 'Seller' });
    await expect(menu.getByRole('link')).toHaveCount(1);
    await expect(menu.getByRole('link', { name: 'Start selling' })).toHaveAttribute('aria-current', 'page');
    await expect(menu.getByRole('link', { name: 'Your orders' })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: 'Account security' })).toHaveCount(0);

    // The saved state: the API list is empty and no membership row exists.
    expect((await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf(member))).data).toEqual({ items: [], nextCursor: null });
    expect(scalar(`select count(*) from "ShopMembership" where "userId"='${userId(member.email)}'`)).toBe('0');
  });

  test('entry.startnav.mobile-layout: at 390 px the menu stacks above the form and nothing scrolls sideways', async ({ page }) => {
    covers('entry.startnav.mobile-layout');
    await memberWithoutShop(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(HOME);
    const menu = await page.getByRole('navigation', { name: 'Seller' }).boundingBox();
    const card = await page.getByRole('heading', { level: 1, name: 'Open your shop' }).boundingBox();
    expect(menu && card && menu.y + menu.height <= card.y, 'the menu is above the form').toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Start selling reloads the same page.
    await page.getByRole('link', { name: 'Start selling' }).click();
    await expect(page).toHaveURL(HOME);
  });

  test('entry.index.loading-skeleton: the page streams a grey block, with no "Loading" text, while the list loads', async ({ page }) => {
    covers('entry.index.loading-skeleton');
    await memberWithoutShop(page);
    const html = await (await page.request.get(HOME)).text();
    expect(html).toMatch(/data-slot="skeleton"[^>]*aria-hidden="true"/);
    expect(html).not.toMatch(/>Loading/);
  });

  test('entry.index.one-shop-redirect entry.index.legacy-inventory-redirect: one shop goes straight to its overview, the old inventory address to its inventory', async ({ page }) => {
    covers('entry.index.one-shop-redirect', 'entry.index.legacy-inventory-redirect');
    const member = await memberWithoutShop(page);
    const { shopId } = await openShopByApi(member);

    // The server answers with the redirect; the picker is never sent.
    const html = await (await page.request.get(HOME)).text();
    expect(html).not.toContain('Choose a shop to open its dashboard.');
    expect(html).toContain(`NEXT_REDIRECT;replace;/dashboard/seller/${shopId}`);

    await page.goto(HOME);
    await expect(page).toHaveURL(`${HOME}/${shopId}`);
    await page.goto(`${HOME}/inventory`);
    await expect(page).toHaveURL(`${HOME}/${shopId}/inventory`);
  });

  test('entry.index.many-shops-picker entry.index.suspended-or-deleting-in-list entry.index.legacy-inventory-redirect: several shops show the picker with status badges; closed shops are left out', async ({ page }) => {
    covers('entry.index.many-shops-picker', 'entry.index.suspended-or-deleting-in-list', 'entry.index.legacy-inventory-redirect');
    const member = await memberWithoutShop(page);
    const first = await openShopByApi(member);
    const suspended = await openSecondShop(member, 'Aiqa Suspended');
    const closing = await openSecondShop(member, 'Aiqa Closing');
    const closed = await openSecondShop(member, 'Aiqa Closed');
    setShopStatus(suspended.shopId, 'SUSPENDED');
    setShopStatus(closing.shopId, 'DELETING');
    setShopStatus(closed.shopId, 'DELETED');

    await page.goto(HOME);
    await expect(page).toHaveURL(HOME);
    await expect(page.getByRole('heading', { level: 1, name: 'Your shops' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Your shops' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByRole('link', { name: new RegExp(first.shopName) })).toHaveAttribute('href', `${HOME}/${first.shopId}`);
    await expect(list.getByRole('listitem').filter({ hasText: 'Aiqa Suspended' })).toContainText('Suspended');
    await expect(list.getByRole('listitem').filter({ hasText: 'Aiqa Closing' })).toContainText('Closing');
    await expect(list.getByRole('listitem').filter({ hasText: first.shopName })).not.toContainText(/Suspended|Closing|Closed/);
    await expect(list).not.toContainText('Aiqa Closed');
    // The API agrees: three shops, the closed one absent, statuses as stored.
    const listed = (await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf(member))).data.items as { id: string; status: string; role: string }[];
    expect(listed.map((s) => `${s.status}:${s.role}`).sort()).toEqual(['ACTIVE:OWNER', 'DELETING:OWNER', 'SUSPENDED:OWNER']);
    expect(scalar(`select status from "Shop" where id='${closed.shopId}'`)).toBe('DELETED');

    // Several shops: the old inventory address falls back to the picker.
    await page.goto(`${HOME}/inventory`);
    await expect(page).toHaveURL(HOME);
  });

  test('entry.index.one-shop-with-cursor entry.index.repeated-cursor-param: a valid cursor keeps the picker; a repeated cursor is ignored', async ({ page }) => {
    covers('entry.index.one-shop-with-cursor', 'entry.index.repeated-cursor-param');
    const member = await memberWithoutShop(page);
    await openShopByApi(member);
    await openSecondShop(member, 'Aiqa Second');
    const token = await tokenOf(member);
    const firstPage = (await sellerCall('GET', '/api/shops/mine?limit=1', undefined, token)).data as { items: { name: string }[]; nextCursor: string };
    expect(firstPage.nextCursor).toBeTruthy();

    // The cursor of the first row: only the second shop is left, with a link back to the first page.
    await page.goto(`${HOME}?cursor=${encodeURIComponent(firstPage.nextCursor)}`);
    await expect(page.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'First page' })).toHaveAttribute('href', HOME);

    // A repeated parameter is no cursor: the page starts at the first row, no error.
    await page.goto(`${HOME}?cursor=a&cursor=b`);
    await expect(page.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(2);
  });

  test('entry.index.one-shop-with-cursor: a member of one shop who opens a cursor sees the picker, not a redirect', async ({ page }) => {
    covers('entry.index.one-shop-with-cursor');
    const member = await memberWithoutShop(page);
    const { shopId } = await openShopByApi(member);
    // A real cursor from another account (made through the API only, so this browser stays signed in as `member`).
    const other = { email: uniqueEmail('aiqa-cursor') };
    expect((await sellerCall('POST', '/api/auth/register', { email: other.email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
    await openShopByApi(other);
    await openSecondShop(other, 'Aiqa Cursor Source');
    const cursor = ((await sellerCall('GET', '/api/shops/mine?limit=1', undefined, await tokenOf(other))).data as { nextCursor: string }).nextCursor;
    await page.goto(`${HOME}?cursor=${encodeURIComponent(cursor)}`);
    await expect(page).toHaveURL(new RegExp(`${HOME}\\?cursor=`));
    await expect(page.getByRole('heading', { level: 1, name: 'Your shops' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
    expect(shopId).toBeTruthy();
  });

  test('entry.index.invalid-cursor entry.index.error-boundary: a cursor the API refuses shows "That page link is no longer valid." with a way to the first page', async ({ page }) => {
    covers('entry.index.invalid-cursor');
    const member = await memberWithoutShop(page);
    await openShopByApi(member);
    await openSecondShop(member, 'Aiqa Two');
    const api = watchApi(page);
    await page.goto(`${HOME}?cursor=garbage`);
    // W04 B-36: the 400 is told in words with a button back to the first page (not the generic error page).
    await expect(page.getByText('That page link is no longer valid.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute('href', HOME);
    expect(api.writes()).toEqual([]);
  });

  test.fixme('entry.index.error-boundary: a 5xx of GET /shops/mine shows the error page with a reference and Try again', async () => {
    covers('entry.index.error-boundary');
    // The list is read by the web server, so a browser route cannot answer 5xx; it needs the API stopped, which a spec must not do.
  });

  test.fixme('entry.index.session-expired-401: a 401 of GET /shops/mine after the session check goes to /login?returnTo=/dashboard/seller', async () => {
    covers('entry.index.session-expired-401');
    // The two server reads share one session; a 401 only on the second one cannot be made without a race.
  });

  test('entry.index.signed-out-redirect entry.index.legacy-inventory-redirect: a signed-out visitor goes to sign-in with the full address as returnTo, before any shop call', async ({ page }) => {
    covers('entry.index.signed-out-redirect', 'entry.index.legacy-inventory-redirect');
    const api = watchApi(page);
    await page.goto(`${HOME}?cursor=x`);
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(`${HOME}?cursor=x`)}`);
    await page.goto(`${HOME}/inventory`);
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(`${HOME}/inventory`)}`);
    expect(api.count('GET', /\/shops/)).toBe(0);
  });

  test('entry.index.signed-out-redirect: a signed-out visit to a section of a shop keeps the section and the query in returnTo (W04 B-33, register B-023)', async ({ page }) => {
    covers('entry.index.signed-out-redirect');
    const shopId = '11111111-1111-4111-8111-111111111111';
    await page.goto(`${HOME}/${shopId}/inventory?q=mug`);
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(`${HOME}/${shopId}/inventory?q=mug`)}`);
  });

  test('entry.index.legacy-dashboard-redirect: /dashboard goes to the seller dashboard and /dashboard/settings to account security', async ({ page }) => {
    covers('entry.index.legacy-dashboard-redirect');
    await memberWithoutShop(page);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(HOME);
    await page.goto('/dashboard/settings');
    await expect(page).toHaveURL('/account/security');
  });

  test('entry.index: the shops the picker lists are exactly the ones the member owns (saved state)', async ({ page }) => {
    covers('entry.index.many-shops-picker');
    const member = await memberWithoutShop(page);
    await openShopByApi(member);
    await openSecondShop(member, 'Aiqa Rows');
    const shops = await myShops(await tokenOf(member));
    expect(shops).toHaveLength(2);
    expect(scalar(`select count(*) from "ShopMembership" where "userId"='${userId(member.email)}' and role='OWNER'`)).toBe('2');
  });
});
