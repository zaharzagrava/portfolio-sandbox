import { expect, test, type Page } from '@playwright/test';
import { register } from '../../helpers';
import { UNKNOWN_ID } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { setShopStatus } from '../support/db';
import { covers, isPhone, sellerNav } from './support';

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
  test('entry.shell.desktop-layout: from 1024 px a 256 px sidebar and no shop bar; below it the bar and no sidebar (1023 and 1024 exactly)', async ({ page }) => {
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
        await expect(bar.getByRole('button', { name: 'Open menu' })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}: no sideways scroll`).toBe(true);
    }
  });

  test('entry.shell.sidebar-switcher entry.shell.nav-landmark entry.shell.nav-account-links entry.shell.nav-current-marker: the menu is one landmark with three headings, the switcher on top, and exactly one current entry', async ({ page }) => {
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

  test('entry.shell.nav-click-pending-skeleton entry.shell.nav-no-pending-leak: a click on another entry shows a skeleton at once and the menu stays; the current entry and modified clicks start none; leaving by Account links leaves no skeleton behind', async ({ page, context }) => {
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

  test('entry.shell.mobile-banner-region-order: the banner region is hidden when empty; offline notice comes before the shop status banner', async ({ page, context }) => {
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

  test('entry.shell.nav-click-pending-skeleton: a click whose page never arrives gives up after 15 s and shows the old page again', async ({ page }) => {
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
