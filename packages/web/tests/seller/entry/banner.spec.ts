import { expect, test, type Page } from '@playwright/test';
import { SEED, register, sellerCall, uniqueEmail } from '../../helpers';
import { tokenOf } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { rows, scalar, setShopStatus, userId } from '../support/db';
import { covers } from './support';

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
  test('entry.banner.active-none entry.banner.suspended entry.banner.closing entry.banner.deleted-status: no banner and no gap on an active shop; the stored status gives the words on every page', async ({ page }) => {
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

  test('entry.banner.deleted-status: a status that is neither active nor suspended reads as closing', async ({ page }) => {
    covers('entry.banner.deleted-status');
    const { shopId } = await ownerShop(page);
    // DELETED is the only other value the screens know; the shop frame treats it as not found (see entry.frame.deleted-shop), so the
    // closing words for it can only be reached with a status the database accepts as text.
    setShopStatus(shopId, 'DELETED');
    await page.goto(`${HOME}/${shopId}`);
    await expect(banner(page)).toHaveCount(0);
    await expect(page.getByText("We couldn't find that shop.").first()).toBeVisible();
  });

  test('entry.banner.writes-disabled: on a suspended or closing shop the write controls are disabled with the banner words, and the API refuses writes (403 shop_suspended, 409 shop_offboarding) but still reads', async ({ page }) => {
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

  test('entry.banner.refresh-after-status-change: a refused write (403 shop_suspended) brings the banner without a reload; the next page load shows the new status', async ({ page }) => {
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

  test('entry.banner.admin-suspend-db entry.banner.offboarding-start-db: the admin suspend and reinstate, and the owner offboarding, write Shop, ShopStatusHistory and Outbox rows', async ({ page }) => {
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
