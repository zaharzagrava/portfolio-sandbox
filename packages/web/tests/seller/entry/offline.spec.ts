import { expect, test } from '@playwright/test';
import { register, uniqueEmail } from '../../helpers';
import { watchApi } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { covers } from './support';

/**
 * AI QA, area "entry", pass 3, section "the offline notice": the shell's "Changes can't be saved" banner, the one refetch when the
 * browser is back, a write while offline, and the pages outside the shell. Each test names the map lines it covers in its title and
 * in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const SHELL_OFFLINE = "You're offline. Changes can't be saved.";
const SITE_OFFLINE = "You're offline. Some things may not load or save until you're back online.";

test.describe('entry: offline', () => {
  test('entry.offline.banner-show entry.offline.banner-clear-refetch entry.offline.no-refetch-when-never-offline: the notice shows above the page when offline, clears when back, and the open lists refetch exactly once', async ({ page, context }) => {
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

  test('entry.offline.write-while-offline: a write while offline says the server could not be reached and keeps what was typed', async ({ page, context }) => {
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

  test('entry.offline.on-no-shop-page: the open-shop form and the picker (outside the shell) carry the site notice but not the shell notice', async ({ page, context }) => {
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
