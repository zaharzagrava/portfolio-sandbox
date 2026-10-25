import { expect, test, type Page } from '@playwright/test';
import { register, sellerCall } from '../../helpers';
import { tokenOf } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { rows, scalar, setShopStatus, userId } from '../support/db';
import { acceptInvite, covers, isPhone, ownerByApi, sellerNav, type Role } from './support';

/**
 * AI QA, area "entry", pass 2, section "the shop picker" (/dashboard/seller with several shops) and the 51-shop paging.
 * Each test names the map lines it covers in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const SUSPENDED_COPY = 'This shop is suspended. You can view data but not make changes.';

/** One member who is OWNER of one shop and ADMIN, STAFF and VIEWER of three others (different owners). */
async function memberOfFour(page: Page) {
  const member = await register(page);
  const me = { email: member.email, password: 'SuperSecurePassword123!' };
  const own = await openShopByApi(me, 'Aiqa Own Shop');
  const shops: Record<Role, { shopId: string; shopName: string }> = { OWNER: own } as never;
  for (const role of ['ADMIN', 'STAFF', 'VIEWER'] as const) {
    const made = await ownerByApi(`Aiqa ${role} Shop`);
    await acceptInvite(page, made.owner, made.shopId, me, role);
    shops[role] = { shopId: made.shopId, shopName: made.shopName };
  }
  return { me, shops };
}

test.describe('entry: the picker', () => {
  test('entry.picker.heading entry.picker.row-link entry.picker.role-badge entry.picker.status-badge entry.picker.list-aria: the list shows name, handle, role and status as stored, and a row opens its shop', async ({ page }) => {
    covers('entry.picker.heading', 'entry.picker.row-link', 'entry.picker.role-badge', 'entry.picker.status-badge', 'entry.picker.list-aria');
    const { me, shops } = await memberOfFour(page);
    setShopStatus(shops.STAFF.shopId, 'SUSPENDED');
    setShopStatus(shops.VIEWER.shopId, 'DELETING');
    await page.goto(HOME);
    await expect(page).toHaveURL(HOME);
    await expect(page.getByRole('heading', { level: 1, name: 'Your shops' })).toBeVisible();
    await expect(page.getByText('Choose a shop to open its dashboard.')).toBeVisible();
    const list = page.getByRole('list', { name: 'Your shops' });
    await expect(list.getByRole('listitem')).toHaveCount(4);
    // "Pages" landmark is there even with no links.
    await expect(page.getByRole('navigation', { name: 'Pages' })).toBeAttached();
    await expect(page.getByRole('navigation', { name: 'Pages' }).getByRole('link')).toHaveCount(0);

    const expected: Record<Role, { label: string; status: string | null }> = {
      OWNER: { label: 'Owner', status: null },
      ADMIN: { label: 'Admin', status: null },
      STAFF: { label: 'Staff', status: 'Suspended' },
      VIEWER: { label: 'Viewer', status: 'Closing' },
    };
    const mine = (await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf(me))).data.items as { id: string; name: string; slug: string; role: string; status: string }[];
    for (const role of ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] as const) {
      const shop = shops[role];
      const [slug, dbRole, dbStatus] = rows(`select s.slug, m.role, s.status from "Shop" s join "ShopMembership" m on m."shopId"=s.id where s.id='${shop.shopId}' and m."userId"='${userId(me.email)}'`)[0]!;
      expect(dbRole, `${role} row in the database`).toBe(role);
      expect(mine.find((s) => s.id === shop.shopId)).toMatchObject({ role, slug, status: dbStatus });
      const row = list.getByRole('listitem').filter({ hasText: shop.shopName });
      await expect(row.getByRole('link')).toHaveAttribute('href', `${HOME}/${shop.shopId}`);
      await expect(row).toContainText(`@${slug}`);
      await expect(row).toContainText(expected[role].label);
      for (const word of ['Suspended', 'Closing', 'Closed']) {
        if (word === expected[role].status) await expect(row).toContainText(word);
        else await expect(row).not.toContainText(word);
      }
      const box = await row.getByRole('link').boundingBox();
      expect(box!.height, `${role} row height`).toBeGreaterThanOrEqual(56);
    }
    // A click opens that shop's overview.
    await list.getByRole('link', { name: new RegExp(shops.ADMIN.shopName) }).click();
    await expect(page).toHaveURL(`${HOME}/${shops.ADMIN.shopId}`);
    await expect(page.getByRole('heading', { level: 1, name: shops.ADMIN.shopName })).toBeVisible();
  });

  test('entry.picker.long-name-truncate: a very long name and handle are cut with an ellipsis and nothing scrolls sideways at 390 px', async ({ page }) => {
    covers('entry.picker.long-name-truncate');
    const member = await register(page);
    const me = { email: member.email };
    const longName = `W${'i'.repeat(78)}M`;
    await openShopByApi(me, longName);
    const token = await tokenOf(me);
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const slug = `l${stamp}${'o'.repeat(38 - stamp.length)}g`;
    expect((await sellerCall('POST', '/api/shops', { name: longName, slug }, token)).status).toBe(201);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(HOME);
    const row = page.getByRole('list', { name: 'Your shops' }).getByRole('listitem').filter({ hasText: `@${slug}` });
    await expect(row).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const nameSpan = row.locator('span.truncate').first();
    await expect(nameSpan).toHaveCSS('text-overflow', 'ellipsis');
    expect(await nameSpan.evaluate((node) => node.scrollWidth >= node.clientWidth)).toBe(true);
    const handleSpan = row.locator('span.truncate').nth(1);
    await expect(handleSpan).toHaveCSS('text-overflow', 'ellipsis');
    const box = await row.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });

  test('entry.picker.suspended-shop-click: a suspended or closing shop opens read-only with its banner, it is not blocked', async ({ page }) => {
    covers('entry.picker.suspended-shop-click');
    const member = await register(page);
    const me = { email: member.email };
    const first = await openShopByApi(me, 'Aiqa Sus One');
    const second = await openShopByApi(me, 'Aiqa Sus Two');
    setShopStatus(first.shopId, 'SUSPENDED');
    setShopStatus(second.shopId, 'DELETING');
    await page.goto(HOME);
    const list = page.getByRole('list', { name: 'Your shops' });
    await list.getByRole('link', { name: /Aiqa Sus One/ }).click();
    await expect(page).toHaveURL(`${HOME}/${first.shopId}`);
    await expect(page.getByText(SUSPENDED_COPY)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Aiqa Sus One' })).toBeVisible();
    const read = await sellerCall('GET', `/api/shops/${first.shopId}`, undefined, await tokenOf(me));
    expect([read.status, read.data.status]).toEqual([200, 'SUSPENDED']);
    // The same page for a closing shop, with the other words.
    await page.goto(`${HOME}/${second.shopId}`);
    await expect(page.getByText('This shop is being closed. You can view data but not make changes.')).toBeVisible();
    expect(scalar(`select status from "Shop" where id='${first.shopId}'`)).toBe('SUSPENDED');
  });

  test('entry.switcher.button entry.switcher.list-content: the switcher button states open/closed, the list shows name, handle, role, status and the current shop', async ({ page }) => {
    covers('entry.switcher.button', 'entry.switcher.list-content');
    const { me, shops } = await memberOfFour(page);
    setShopStatus(shops.STAFF.shopId, 'SUSPENDED');
    setShopStatus(shops.VIEWER.shopId, 'DELETING');
    await page.goto(`${HOME}/${shops.ADMIN.shopId}`);
    await expect(page.getByRole('heading', { level: 1, name: shops.ADMIN.shopName })).toBeVisible();
    await sellerNav(page);
    const root = isPhone(page) ? page.getByRole('dialog', { name: 'Seller menu' }) : page.locator('aside');
    const button = root.getByRole('button').first();
    await expect(button).toHaveText(shops.ADMIN.shopName);
    await expect(button.locator('svg')).toHaveCount(1); // the chevron
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).not.toHaveAttribute('aria-controls', /.+/);
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const listId = await button.getAttribute('aria-controls');
    expect(listId).toBeTruthy();
    const list = root.getByRole('list', { name: 'Your shops' });
    await expect(list).toHaveAttribute('id', listId!);
    const items = list.getByRole('listitem');
    await expect(items).toHaveCount(4);

    const token = await tokenOf(me);
    const mine = (await sellerCall('GET', '/api/shops/mine', undefined, token)).data.items as { id: string; slug: string; role: string; status: string }[];
    const label: Record<string, string> = { OWNER: 'Owner', ADMIN: 'Admin', STAFF: 'Staff', VIEWER: 'Viewer' };
    const statusWord: Record<string, string> = { SUSPENDED: 'Suspended', DELETING: 'Closing' };
    for (const role of ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] as const) {
      const shop = shops[role];
      const stored = rows(`select s.slug, m.role, s.status from "Shop" s join "ShopMembership" m on m."shopId"=s.id where s.id='${shop.shopId}' and m."userId"='${userId(me.email)}'`)[0]!;
      expect(mine.find((s) => s.id === shop.shopId)).toMatchObject({ slug: stored[0], role: stored[1], status: stored[2] });
      const item = items.filter({ hasText: shop.shopName });
      await expect(item).toContainText(stored[0]!);
      await expect(item).toContainText(label[stored[1]!]!);
      if (statusWord[stored[2]!]) await expect(item).toContainText(statusWord[stored[2]!]!);
      else await expect(item).not.toContainText(/Suspended|Closing|Closed/);
      if (role === 'ADMIN') {
        await expect(item).toContainText('Current');
        await expect(item.getByRole('link')).toHaveAttribute('aria-current', 'true');
      } else {
        await expect(item).not.toContainText('Current');
        await expect(item.getByRole('link')).not.toHaveAttribute('aria-current', /.*/);
      }
    }
    // A second press closes it again, Escape closes it and returns focus to the button.
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toHaveCount(0);
    await button.click();
    await page.keyboard.press('Escape');
    if (!isPhone(page)) {
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toBeFocused();
    }
  });
});
