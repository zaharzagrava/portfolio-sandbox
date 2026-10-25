import { expect, test, type Page } from '@playwright/test';
import { NEW_USER_PASSWORD, register, sellerCall, totp, waitForForm } from '../../helpers';
import { UNKNOWN_ID, forced, mainText, tokenOf, watchApi } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { rows, scalar, setShopStatus } from '../support/db';
import { covers, isPhone, sellerNav } from './support';

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
  test('entry.auth.login-return: a signed-out visit to a deep link returns to that link after sign-in, with the query; the two-step code step keeps it too', async ({ page }) => {
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

  test('entry.auth.session-ended-once entry.auth.expired-cookie-on-navigation: a 401 on parallel seller requests runs the session end once; a cleared cookie and a click on the menu goes to sign-in with no page flash', async ({ page }) => {
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

  test('entry.misc.header-link: signed in, the account menu offers Dashboard to /dashboard and it ends on the shop; signed out there is no such link', async ({ page }) => {
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

  test('entry.misc.title-focus-on-navigation: every shell page has one h1; a client navigation updates the title announced to screen readers and does not leave focus on a removed element', async ({ page }) => {
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

  test('entry.misc.dark-mode: the banners read well in dark mode (text against background at least 4.5 : 1)', async ({ page, context }) => {
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

  test('entry.misc.keyboard-skip: Tab reaches every sidebar link with a visible focus ring, and after the last one focus moves into the page', async ({ page }) => {
    covers('entry.misc.keyboard-skip');
    test.skip(isPhone(page), 'the drawer is covered by entry-drawer');
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

  test('entry.misc.unmounted-shell-account-links: Your orders and Account security leave the dashboard and Back returns to the same page', async ({ page }) => {
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

  test('entry.misc.invalid-percent-path entry.misc.trailing-slash entry.form.api-unknown-shop-id: broken addresses give the one not-found page and never a 500; a trailing slash keeps the current marker; a malformed id equals an unknown id', async ({ page }) => {
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

  test('entry.form.api-name-limits: a one-letter and an 81-letter shop name are stopped by the form before any request; the same bodies sent by hand are refused by the API; nothing is saved', async ({ page }) => {
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
