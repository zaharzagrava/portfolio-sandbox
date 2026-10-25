import { expect, test, type Page } from '@playwright/test';
import { clickThroughDevOverlay, register } from '../../helpers';
import { UNKNOWN_ID, openSecondShop } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { covers } from './support';

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
const opener = (page: Page) => bar(page).getByRole('button', { name: 'Open menu' });

async function openDrawer(page: Page) {
  await clickThroughDevOverlay(page);
  await expect(page.getByRole('dialog')).toBeHidden(); // a sheet still sliding out blocks the button
  await opener(page).click();
  await expect(drawer(page)).toBeVisible();
}

test.describe('entry: the shop bar and drawer', () => {
  test('entry.drawer.shop-bar entry.drawer.page-label: the bar shows Open menu (44 px), the shop name and the page name; gone at 1024 px', async ({ page }) => {
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

  test('entry.drawer.open entry.drawer.description-sr entry.drawer.close-button entry.drawer.escape entry.drawer.outside-click: the sheet has the sidebar content, a description for screen readers, focus inside; the X, Escape and the backdrop close it and focus returns to Open menu', async ({ page }) => {
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

  test('entry.drawer.close-on-navigate entry.drawer.switcher-inside: choosing an entry closes the drawer and shows the page; Back while open closes it; the switcher works inside and closes both', async ({ page }) => {
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

  test('entry.drawer.sideways-scroll: an 80-character shop name never scrolls a shell page sideways at 390 px', async ({ page }) => {
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

  test('entry.drawer.rotate-resize: growing to 1280 px with the drawer open shows the sidebar, closes the drawer and leaves no scroll lock', async ({ page }) => {
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
