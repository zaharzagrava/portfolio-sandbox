import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SEED, clickThroughDevOverlay, openShop, register, resetRateLimits, sellerCall, sellerMenu, shopPath } from '../helpers';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';

/**
 * VA rows of W04 (AS-01 layout, AS-54, AS-86, AS-88, AS-91, AS-98): the seller shell at the phone (390 x 844) and desktop
 * (1280 x 800) widths (the `mobile` and `desktop` projects run every test). The member is real (registered through the UI,
 * so the server guard passes) and the shop is opened through the form. The shell is a Server Component, so what the server
 * reads cannot be stubbed in the browser: a suspended shop is made through the platform admin's API, an offline browser
 * with `context.setOffline`, and the loading skeleton by holding back the page's own RSC request with `page.route`.
 * Animations are off (config) and times are not on screen. Baselines are committed when the final run produces them.
 */

const stylePath = path.join(__dirname, 'hide-dev-overlay.css');
const content = (page: Page) => page.locator('#main-content');
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;

/** Axe on the page and nothing wider than the viewport at 320 px (the phone frame must not scroll sideways). */
async function expectAccessibleAndContained(page: Page) {
  await expectNoSeriousViolations(page);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  await expectMainFitsWidth(page);
  if (original) await page.setViewportSize(original);
}

async function memberWithShop(page: Page) {
  const member = await register(page);
  const shop = await openShop(page);
  return { ...member, ...shop };
}

/** The platform admin suspends (or reinstates) a shop through the real API. */
async function setSuspended(shopId: string, suspended: boolean) {
  const login = await sellerCall('POST', '/api/auth/login', { email: SEED.admin, password: SEED.password });
  expect(login.status).toBe(200);
  const token: string = login.data.accessToken.token;
  const result = await sellerCall('POST', `/api/admin/shops/${shopId}/${suspended ? 'suspend' : 'reinstate'}`, { reason: 'visual test' }, token);
  expect(result.status).toBe(200);
}

test.describe('Seller shell layout', () => {
  test('W04 AS-01 VA open-shop form: no shop yet', async ({ page }) => {
    await register(page);
    await resetRateLimits();
    await page.goto('/dashboard/seller');
    await expect(page.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
    await expect(page.getByLabel('Shop name')).toBeVisible();
    await expect(page.getByLabel('Handle')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open shop' })).toBeVisible();
    await expect(content(page)).toHaveScreenshot('open-shop-form.png', { stylePath });
    await expectAccessibleAndContained(page);
  });

  test('W04 AS-98 VA shell: sidebar on desktop, top bar and drawer on the phone', async ({ page }) => {
    const { shopId, shopName } = await memberWithShop(page);
    await page.goto(shopPath(shopId, 'inventory'));
    if (isPhone(page)) {
      const bar = page.getByRole('region', { name: 'Shop bar' });
      await expect(bar.getByText(shopName)).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Seller' })).toBeHidden();
      await expect(page).toHaveScreenshot('shell-phone-closed.png', { stylePath });
      await clickThroughDevOverlay(page);
      await bar.getByRole('button', { name: 'Open seller menu' }).click();
      const drawer = page.getByRole('dialog');
      await expect(drawer.getByRole('navigation', { name: 'Seller' }).getByRole('link', { name: 'Inventory' })).toHaveAttribute('aria-current', 'page');
      await expect(drawer).toHaveScreenshot('shell-phone-drawer.png', { stylePath });
      await expectNoSeriousViolations(page);
      await page.keyboard.press('Escape');
      await expect(bar.getByRole('button', { name: 'Open seller menu' })).toBeFocused();
    } else {
      const nav = page.getByRole('navigation', { name: 'Seller' });
      await expect(nav.getByRole('link', { name: 'Inventory' })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('button', { name: 'Open seller menu' })).toBeHidden();
      await expect(page).toHaveScreenshot('shell-desktop.png', { stylePath });
      await expectAccessibleAndContained(page);
    }
  });

  test('W04 AS-98 VA shop switcher: list open on the current section', async ({ page }) => {
    const { shopId, shopName } = await memberWithShop(page);
    await page.goto(shopPath(shopId, 'orders'));
    if (isPhone(page)) await page.getByRole('region', { name: 'Shop bar' }).getByRole('button', { name: 'Open seller menu' }).click();
    const scope = isPhone(page) ? page.getByRole('dialog') : page.locator('aside');
    await scope.getByRole('button', { name: new RegExp(shopName) }).click();
    await expect(scope.getByRole('list', { name: 'Your shops' })).toBeVisible();
    await expect(scope.getByRole('link', { name: 'All your shops' })).toBeVisible();
    // The drawer is taller than the phone: opening the switcher can leave it scrolled, and the element shot follows the scroll.
    await scope.evaluate((element) => element.scrollTo(0, 0));
    await expect(scope).toHaveScreenshot('switcher-open.png', { stylePath });
    await expectNoSeriousViolations(page);
  });

  test.fixme('W04 AS-54 VA forbidden panel: a viewer opens API keys', async ({ page }) => {
    // Needs a VIEWER member of a shop. The invitation journey (tests/seller-team.spec.ts, readInviteLink) can produce one;
    // once it exists: sign in as the viewer, open shopPath(shopId, 'developers/api-keys'), expect the panel
    // "You don't have access to this page." with the role and the link "Overview", then screenshot and axe it.
    await page.goto('/');
  });

  test('W04 AS-86 VA suspended banner: read-only shop', async ({ page }) => {
    const { shopId } = await memberWithShop(page);
    await setSuspended(shopId, true);
    try {
      await page.goto(shopPath(shopId));
      await expect(page.getByLabel('Shop status')).toHaveText('This shop is suspended. You can view data but not make changes.');
      // The live panel changes height with its connection (connecting, live with the bars, unavailable): shoot it once live.
      const live = page.getByRole('region', { name: 'Last 60 seconds' });
      await expect(live.getByRole('status')).toHaveText('Live', { timeout: 15_000 });
      await expect(live.getByRole('img')).toBeVisible();
      await expect(content(page)).toHaveScreenshot('suspended-banner.png', { stylePath, mask: [live.locator('[data-live-values]')] });
      await expectAccessibleAndContained(page);
    } finally {
      await setSuspended(shopId, false);
    }
  });

  test('W04 AS-88 VA offline banner', async ({ page, context }) => {
    const { shopId } = await memberWithShop(page);
    await page.goto(shopPath(shopId));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText("You're offline. Changes can't be saved.")).toBeVisible();
    await expect(content(page)).toHaveScreenshot('offline-banner.png', { stylePath });
    await expectAccessibleAndContained(page);
    await context.setOffline(false);
    await expect(page.getByText("You're offline. Changes can't be saved.")).toBeHidden();
  });

  test('W04 AS-91 VA loading skeletons: the frame is on screen, the content is a skeleton', async ({ page }) => {
    const { shopId } = await memberWithShop(page);
    await page.goto(shopPath(shopId));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Hold back the page's own server render (the RSC request of a client navigation) so the loading state stays on screen.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(new RegExp(`/dashboard/seller/${shopId}/inventory\\?_rsc=`), async (route) => {
      await held;
      await route.continue();
    });
    const nav = (await sellerMenu(page)).getByRole('navigation', { name: 'Seller' });
    await nav.getByRole('link', { name: 'Inventory' }).click();
    await expect(page.locator('[data-skeleton]').first()).toBeVisible();
    await expect(page.getByText('Loading...')).toHaveCount(0);
    await expect(page).toHaveScreenshot('loading-skeleton.png', { stylePath });
    await expectNoSeriousViolations(page);
    release();
  });
});
