import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { register, sellerCall, sellerMenu } from '../../helpers';
import { UNKNOWN_ID, openSecondShop, tokenOf, watchApi } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { rows, scalar, setShopStatus, userId } from '../support/db';
import { acceptInvite, covers, isPhone, ownerByApi } from './support';

/**
 * AI QA, area "entry", pass 3, section "the shop switcher": the list in the sidebar (desktop) and in the drawer (phone), what a
 * choice keeps (section, not the query), how it opens and closes, the badges, the long names, the stale list. Each test names the
 * map lines it covers in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const PASSWORD = 'SuperSecurePassword123!';

/** A member who owns shop A and is VIEWER of shop B (someone else's). */
async function ownerAndViewer(page: Page) {
  const member = await register(page);
  const me = { email: member.email, password: PASSWORD };
  const a = await openShopByApi(me, 'Aiqa Alpha');
  const other = await ownerByApi('Aiqa Bravo');
  await acceptInvite(page, other.owner, other.shopId, me, 'VIEWER');
  return { me, a, b: { shopId: other.shopId, shopName: other.shopName } };
}

/** Opens the switcher (in the drawer on a phone); returns the menu and the list. */
async function openSwitcher(page: Page) {
  const menu = await sellerMenu(page);
  const trigger = menu.getByRole('button').first();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return { menu, trigger, list: menu.getByRole('list', { name: 'Your shops' }) };
}

test.describe('entry: the shop switcher', () => {
  test('entry.switcher.keeps-section entry.switcher.keeps-section-forbidden entry.switcher.keeps-query entry.switcher.close-on-choose entry.switcher.close-on-path-change: a choice keeps the section and drops the query; a shop where the role lacks the page shows the access panel; the list closes', async ({ page }) => {
    covers('entry.switcher.keeps-section', 'entry.switcher.keeps-section-forbidden', 'entry.switcher.keeps-query', 'entry.switcher.close-on-choose', 'entry.switcher.close-on-path-change');
    const { a, b } = await ownerAndViewer(page);
    const bLink = (menu: ReturnType<Page['locator']>) => menu.getByRole('list', { name: 'Your shops' }).getByRole('link').filter({ hasText: b.shopName });
    const places: [string, string][] = [
      ['', ''],
      ['/inventory?q=mug&cursor=abc', '/inventory'],
      ['/orders?status=PAID&page=2', '/orders'],
      [`/developers/webhooks/${UNKNOWN_ID}`, '/developers/webhooks'],
      ['/developers/api-keys', '/developers/api-keys'],
      ['/team?tab=invitations', '/team'],
    ];
    for (const [from, kept] of places) {
      await page.goto(`${HOME}/${a.shopId}${from}`);
      const { menu } = await openSwitcher(page);
      await expect(bLink(menu), `href from ${from || 'overview'}`).toHaveAttribute('href', `${HOME}/${b.shopId}${kept}`);
    }

    // Click: inventory with a filter -> other shop's inventory, no query, empty search box.
    await page.goto(`${HOME}/${a.shopId}/inventory?q=mug&cursor=abc`);
    const watch = watchApi(page);
    const { menu, list } = await openSwitcher(page);
    await bLink(menu).click();
    await expect(page).toHaveURL(`${HOME}/${b.shopId}/inventory`);
    expect(new URL(page.url()).search).toBe('');
    // Closed after the choice: the list is gone and, on a phone, the drawer too.
    if (isPhone(page)) await expect(page.getByRole('dialog', { name: 'Seller menu' })).toBeHidden();
    else await expect(list).toBeHidden();
    await expect(page.getByRole('heading', { name: /Inventory/ }).first()).toBeVisible();
    // No request of the second shop carries the first shop's filter.
    expect(watch.seen.filter((s) => /\bq=mug|cursor=abc/.test(s.path)).map((s) => s.path)).toEqual([]);
    const searchBox = page.getByRole('searchbox').first();
    if (await searchBox.count()) await expect(searchBox).toHaveValue('');

    // A role that lacks the page: the VIEWER has no API keys permission in shop B.
    await page.goto(`${HOME}/${a.shopId}/developers/api-keys`);
    await expect(page.getByRole('heading', { name: 'API keys' }).first()).toBeVisible();
    const second = await openSwitcher(page);
    await bLink(second.menu).click();
    await expect(page).toHaveURL(`${HOME}/${b.shopId}/developers/api-keys`);
    await expect(page.getByRole('heading', { name: "You don't have access to this page." })).toBeVisible();
    await expect(page.getByText('Your role in this shop: Viewer.')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    // Closing on a changed address: open the list, go Back.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${a.shopId}/developers/api-keys$`));
    const third = await openSwitcher(page);
    if (!isPhone(page)) {
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`${b.shopId}/developers/api-keys$`));
      await expect(third.list).toBeHidden();
      await expect(third.trigger).toHaveAttribute('aria-expanded', 'false');
    } else {
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`${b.shopId}/developers/api-keys$`));
      await expect(page.getByRole('dialog', { name: 'Seller menu' })).toBeHidden();
    }
  });

  test('entry.switcher.escape entry.switcher.not-closing-on-outside-click entry.switcher.keyboard-nav entry.switcher.one-shop: Escape closes the list and returns focus; a click outside does not close; Tab goes button, shops, All your shops; no arrow keys', async ({ page }) => {
    covers('entry.switcher.escape', 'entry.switcher.not-closing-on-outside-click', 'entry.switcher.keyboard-nav', 'entry.switcher.one-shop');
    const { a, b } = await ownerAndViewer(page);

    // One shop: the owner of a single shop still has the button and a one-item list with "Current".
    const solo = await ownerByApi('Aiqa Solo');
    const soloPage = await page.context().browser()!.newContext({ viewport: page.viewportSize() ?? undefined });
    const soloTab = await soloPage.newPage();
    const soloMember = await register(soloTab);
    const soloShop = await openShopByApi({ email: soloMember.email }, 'Aiqa Only One');
    await soloTab.goto(`${HOME}/${soloShop.shopId}`);
    const one = await openSwitcher(soloTab);
    await expect(one.trigger).toHaveText('Aiqa Only One');
    await expect(one.list.getByRole('listitem')).toHaveCount(1);
    await expect(one.list.getByRole('listitem')).toContainText('Current');
    await expect(one.list.getByRole('link')).toHaveAttribute('aria-current', 'true');
    await expect(one.menu.getByRole('link', { name: 'All your shops' })).toHaveAttribute('href', HOME);
    await soloPage.close();
    void solo;

    await page.goto(`${HOME}/${a.shopId}/inventory`);
    const { menu, trigger, list } = await openSwitcher(page);
    await expect(trigger).toHaveAttribute('aria-controls', /.+/);
    await expect(list.getByRole('listitem')).toHaveCount(2);

    // Tab order from the button: each shop link in list order, then "All your shops".
    await trigger.focus();
    const names = await list.getByRole('link').evaluateAll((links) => links.map((link) => link.querySelector('span span')?.textContent ?? ''));
    expect(names).toHaveLength(2);
    for (const [index, name] of names.entries()) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.textContent ?? ''), `Tab ${index + 1}`).toContain(name);
    }
    await page.keyboard.press('Tab');
    await expect(menu.getByRole('link', { name: 'All your shops' })).toBeFocused();

    // Arrow keys do nothing: focus stays where it is, the list stays open.
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('link', { name: 'All your shops' })).toBeFocused();
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(trigger).toBeFocused();
    await expect(list).toBeVisible();

    // A click outside (on the page content) does not close it.
    if (!isPhone(page)) {
      await page.locator('#main-content').click({ position: { x: 5, y: 5 } });
      await expect(list).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    }

    // Escape from inside the list closes it and puts focus back on the button.
    await list.getByRole('link').last().focus();
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).not.toHaveAttribute('aria-controls');
    // On a phone the first Escape closed only the list: the drawer is still open (stopPropagation); the second closes the drawer.
    if (isPhone(page)) {
      await expect(page.getByRole('dialog', { name: 'Seller menu' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Seller menu' })).toBeHidden();
    }
    void b;
  });

  test('entry.switcher.status-badge entry.switcher.stale-list: badges follow the stored status; a shop opened later shows after navigation, with the API list and rows as the source', async ({ page }) => {
    covers('entry.switcher.status-badge', 'entry.switcher.stale-list');
    const { me, a } = await ownerAndViewer(page);
    const c = await openSecondShop(me, 'Aiqa Charlie');
    const d = await openSecondShop(me, 'Aiqa Delta');
    setShopStatus(c.shopId, 'SUSPENDED');
    setShopStatus(d.shopId, 'DELETING');
    expect(scalar(`select status from "Shop" where id='${c.shopId}'`)).toBe('SUSPENDED');
    const mine = (await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf(me))).data.items as { id: string; status: string }[];
    expect(mine.find((s) => s.id === c.shopId)?.status).toBe('SUSPENDED');
    expect(mine.find((s) => s.id === d.shopId)?.status).toBe('DELETING');

    await page.goto(`${HOME}/${a.shopId}`);
    const { list } = await openSwitcher(page);
    const rowOf = (name: string) => list.getByRole('listitem').filter({ hasText: name });
    await expect(rowOf('Aiqa Charlie')).toContainText('Suspended');
    await expect(rowOf('Aiqa Delta')).toContainText('Closing');
    await expect(rowOf('Aiqa Alpha')).not.toContainText(/Suspended|Closing|Closed/);
    await expect(rowOf('Aiqa Bravo')).not.toContainText(/Suspended|Closing|Closed/);
    await expect(rowOf('Aiqa Alpha')).toContainText('Owner');
    await expect(rowOf('Aiqa Bravo')).toContainText('Viewer');
    expect(rows(`select role from "ShopMembership" where "userId"='${userId(me.email)}' order by role`).flat()).toEqual(['OWNER', 'OWNER', 'OWNER', 'VIEWER']);

    // A shop opened while the page is open: the list does not change until the page is loaded again.
    const e = await openSecondShop(me, 'Aiqa Echo');
    if (isPhone(page)) await page.keyboard.press('Escape');
    await expect(rowOf('Aiqa Echo')).toHaveCount(0);
    await page.reload();
    const after = await openSwitcher(page);
    await expect(after.list.getByRole('listitem')).toHaveCount(5);
    await expect(after.list.getByRole('listitem').filter({ hasText: 'Aiqa Echo' })).toHaveCount(1);
    void e;
  });

  test('entry.switcher.long-names entry.switcher.touch-targets: 80-character names and markup in a name stay on one line as text; at 390 px the button and rows are at least 44 px high', async ({ page }) => {
    covers('entry.switcher.long-names', 'entry.switcher.touch-targets');
    await page.setViewportSize({ width: 390, height: 844 });
    const member = await register(page);
    const me = { email: member.email, password: PASSWORD };
    const long = `${'W'.repeat(40)} ${'m'.repeat(39)}`;
    expect(long).toHaveLength(80);
    const markup = '<img src=x onerror="window.__aiqa=1"> <b>b</b>';
    const first = await openShopByApi(me, long);
    const second = await openSecondShop(me, markup);
    await page.goto(`${HOME}/${first.shopId}`);
    const { menu, trigger, list } = await openSwitcher(page);
    // The names are text: no element made from them, nothing ran.
    await expect(list.getByText(markup, { exact: false })).toHaveCount(1);
    await expect(menu.locator('img, b')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __aiqa?: number }).__aiqa)).toBeUndefined();
    // One line each, cut with an ellipsis, inside the screen.
    const nameSpan = list.getByRole('listitem').filter({ hasText: 'WWWW' }).locator('span.truncate').first();
    const css = await nameSpan.evaluate((node) => ({ overflow: getComputedStyle(node).textOverflow, clipped: node.scrollWidth > node.clientWidth, lines: Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)) }));
    expect(css).toMatchObject({ overflow: 'ellipsis', clipped: true, lines: 1 });
    expect(await trigger.evaluate((node) => node.scrollWidth <= node.clientWidth + 1 && getComputedStyle(node.firstElementChild!).textOverflow === 'ellipsis')).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Touch targets.
    for (const target of [trigger, ...(await list.getByRole('link').all()), menu.getByRole('link', { name: 'All your shops' })]) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    void second;
  });

  test('entry.switcher.max-50: with 51 shops the switcher shows 50, scrolls inside its box and "All your shops" carries the API cursor', async ({ page }) => {
    covers('entry.switcher.max-50');
    test.setTimeout(240_000);
    const member = await register(page);
    const memberId = userId(member.email);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { owner, shopId } = await ownerByApi();
      ids.push(shopId);
      const token = await tokenOf(owner);
      for (let n = 0; n < 8; n++) {
        const made = await sellerCall('POST', '/api/shops', { name: `Cap ${i}-${n}`, slug: `aiqa-cap-${Date.now().toString(36)}-${i}-${n}-${Math.floor(Math.random() * 1e4).toString(36)}` }, token);
        expect(made.status).toBe(201);
        ids.push(made.data.id as string);
      }
    }
    const values = ids.slice(0, 51).map((id, index) => `('${id}','${memberId}','VIEWER','invite', now() + interval '${index} milliseconds')`).join(',');
    execFileSync('docker', ['exec', '-i', process.env.AIQA_DB_CONTAINER ?? 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', `insert into "ShopMembership"("shopId","userId",role,source,"createdAt") values ${values}`]);
    const token = await tokenOf(member);
    const one = (await sellerCall('GET', '/api/shops/mine?limit=50', undefined, token)).data as { items: { id: string }[]; nextCursor: string | null };
    expect(one.items).toHaveLength(50);
    expect(one.nextCursor).toBeTruthy();

    await page.goto(`${HOME}/${one.items[0]!.id}`);
    const { menu, list } = await openSwitcher(page);
    await expect(list.getByRole('listitem')).toHaveCount(50);
    await expect(menu.getByRole('link', { name: 'All your shops' })).toHaveAttribute('href', `${HOME}?cursor=${encodeURIComponent(one.nextCursor!)}`);
    const box = await list.evaluate((node) => ({ scrolls: node.scrollHeight > node.clientHeight, height: node.clientHeight, overflowY: getComputedStyle(node).overflowY, maxHeight: getComputedStyle(node).maxHeight }));
    expect(box).toMatchObject({ scrolls: true, overflowY: 'auto', maxHeight: '288px' });
    // The 51st shop is not in the list (it sits on the picker's second page).
    await expect(list.getByRole('link').filter({ has: page.locator(`[href="${HOME}/${ids[50]}"]`) })).toHaveCount(0);
    expect(await list.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')))).not.toContain(`${HOME}/${ids[50]}`);
    // Following the link ends at the picker's second page with that shop.
    await menu.getByRole('link', { name: 'All your shops' }).click();
    await expect(page).toHaveURL(new RegExp(`${HOME}\\?cursor=`));
    await expect(page.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(1);
  });
});
