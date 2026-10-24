import { expect, test } from '@playwright/test';
import { NEW_USER_PASSWORD, register, resetRateLimits, sellerCall, sellerMenu, shopPath } from './helpers';
import { openShopByApi } from './seller-setup';

/**
 * W04 US1/US2: opening a shop, coming back to it and switching between shops (AS-01..AS-03, AS-08..AS-10). Roles and labels
 * only. Every test registers its own member, so nothing is shared with another (L-005).
 */
test.describe('Seller shop entry and overview', () => {
  test('W04 AS-01..AS-03, AS-10: an owner opens a shop from "Start selling" and lands on its overview', async ({ page }) => {
    await register(page);
    await resetRateLimits();
    await page.goto('/dashboard');
    // step 1: the form is reachable from "Start selling" and submits
    await page.getByRole('link', { name: 'Start selling' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
    const shopName = `E2E Shop ${Date.now().toString(36)}`;
    await page.getByLabel('Shop name').fill(shopName);
    await expect(page.getByLabel('Handle')).toHaveValue(/^e2e-shop-[a-z0-9]+$/);
    await page.getByRole('button', { name: 'Open shop' }).click();

    // step 2: the browser goes to the new shop's overview
    await expect(page).toHaveURL(/\/dashboard\/seller\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: shopName })).toBeVisible();

    // step 3: the sections of the overview render from the real API
    await expect(page.getByRole('region', { name: 'Last 60 seconds' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Today (UTC)' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Leaderboard rank' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Top products' })).toBeVisible();
    await expect((await sellerMenu(page)).getByRole('navigation', { name: 'Seller' }).getByRole('link', { name: 'Inventory' })).toBeVisible();
  });

  test('W04 AS-08: a returning owner of one shop lands on its overview', async ({ page }) => {
    const member = await register(page);
    const { shopId, shopName } = await openShopByApi(member);
    await page.goto('/dashboard/seller');
    await expect(page).toHaveURL(new RegExp(`${shopPath(shopId)}$`));
    await expect(page.getByRole('heading', { level: 1, name: shopName })).toBeVisible();
  });

  test('W04 AS-09: an owner of two shops picks one and switches while keeping the section', async ({ page }) => {
    const member = await register(page);
    const first = await openShopByApi(member);
    const login = await sellerCall('POST', '/api/auth/login', { email: member.email, password: NEW_USER_PASSWORD });
    expect(login.status).toBe(200);
    const secondName = `E2E Second ${Date.now().toString(36)}`;
    const created = await sellerCall('POST', '/api/shops', { name: secondName, slug: `e2e-second-${Date.now().toString(36)}` }, login.data.accessToken.token);
    expect(created.status).toBe(201);
    const secondId: string = created.data.id;

    // the picker lists both shops with their role
    await page.goto('/dashboard/seller');
    const list = page.getByRole('list', { name: 'Your shops' });
    await expect(list.getByRole('link', { name: new RegExp(first.shopName) })).toBeVisible();
    await expect(list.getByRole('link', { name: new RegExp(secondName) })).toContainText('Owner');

    // the switcher keeps the section
    await page.goto(shopPath(first.shopId, 'inventory'));
    await (await sellerMenu(page)).getByRole('button', { name: new RegExp(first.shopName) }).first().click();
    await page.getByRole('list', { name: 'Your shops' }).getByRole('link', { name: new RegExp(secondName) }).click();
    await expect(page).toHaveURL(new RegExp(`${shopPath(secondId, 'inventory')}$`));
    await expect((await sellerMenu(page)).getByRole('button', { name: new RegExp(secondName) }).first()).toBeVisible();
  });
});
