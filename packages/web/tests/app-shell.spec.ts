import { expect, test, type Page } from '@playwright/test';
import { login, register, SEED } from './helpers';

/** The tests choose their own width, so each project runs only the ones meant for its layout. */
const onlyDesktop = (testInfo: { project: { name: string } }) => testInfo.project.name !== 'desktop';
const onlyMobile = (testInfo: { project: { name: string } }) => testInfo.project.name !== 'mobile';

const header = (page: Page) => page.getByRole('banner');

test.describe('W07 app shell', () => {
  test('W07 AS-01: header at desktop shows logo, main navigation, search, slots in order (anonymous)', async ({ page }, testInfo) => {
    testInfo.skip(onlyDesktop(testInfo), 'desktop layout');
    await page.goto('/privacy');
    const banner = header(page);
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Marketplace home' })).toHaveAttribute('href', '/');
    const nav = banner.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(['Browse', 'Developers']);
    await expect(banner.getByRole('searchbox', { name: 'Search products' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Open menu' })).toBeHidden();
    // right-hand group, left to right (measured once the session read has settled: the visitor links are wider than the
    // account skeleton, so the group moves when it resolves)
    await expect(banner.getByRole('link', { name: 'Log in' })).toBeVisible();
    await expect(banner.locator('[data-slot="account-skeleton"]')).toHaveCount(0);
    const xs = [
      await banner.getByRole('button', { name: 'AI Assistant' }).boundingBox(),
      await banner.getByRole('button', { name: 'Theme' }).boundingBox(),
      await banner.getByRole('link', { name: /^Cart/ }).boundingBox(),
      await banner.getByRole('link', { name: 'Log in' }).boundingBox(),
    ].map((box) => box!.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    await expect(banner.getByRole('button', { name: 'Notifications' })).toHaveCount(0);
  });

  test('W07 AS-01: a signed-in member gets the bell and the account menu; scrolling keeps the header; a focused link is not hidden behind it', async ({ page }, testInfo) => {
    testInfo.skip(onlyDesktop(testInfo), 'desktop layout');
    await register(page);
    const banner = header(page);
    await expect(banner.getByRole('button', { name: 'Account menu' })).toBeVisible();
    await expect(banner.getByRole('button', { name: /Notifications/i })).toBeVisible();
    await page.goto('/privacy');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(banner).toBeInViewport();
    // Tab to the first footer link from the bottom: it scrolls into view below the header
    const link = page.getByRole('contentinfo').getByRole('link', { name: 'Browse' });
    await link.focus();
    const box = await link.boundingBox();
    const headerBox = await banner.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1);
  });

  test('W07 AS-02: mobile menu opens, lists account entries first, closes on navigation', async ({ page }, testInfo) => {
    testInfo.skip(onlyMobile(testInfo), 'mobile layout');
    await page.goto('/privacy');
    // While the modal sheet is open the rest of the page leaves the accessibility tree: address the button by attribute.
    const open = page.locator('button[aria-label="Open menu"]');
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await open.click();
    const dialog = page.getByRole('dialog', { name: 'Menu' });
    await expect(dialog).toBeVisible();
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    const entries = await dialog.getByRole('link').allTextContents();
    expect(entries.slice(0, 2)).toEqual(['Log in', 'Sign up']);
    expect(entries.slice(2)).toEqual(['Browse', 'Cart', 'Developers']);
    await dialog.getByRole('link', { name: 'Browse' }).click();
    await expect(page).toHaveURL(/\/search/);
    await expect(dialog).toBeHidden();
    // Escape returns focus to the button
    await open.click();
    await page.keyboard.press('Escape');
    await expect(open).toBeFocused();
  });

  test('W07 AS-05: an admin sees Admin in the account menu', async ({ page }, testInfo) => {
    testInfo.skip(onlyDesktop(testInfo), 'desktop layout');
    await login(page, SEED.admin, SEED.password);
    await header(page).getByRole('button', { name: 'Account menu' }).click();
    const items = await page.getByRole('menu').getByRole('menuitem').allTextContents();
    const account = items.findIndex((text) => text.includes('Account & security'));
    expect(account).toBeGreaterThanOrEqual(0);
    expect(items[account + 1]).toContain('Admin');
  });

  test('W07 AS-06: theme choice applies at once and survives reload', async ({ page }, testInfo) => {
    testInfo.skip(onlyDesktop(testInfo), 'desktop layout');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/privacy');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await header(page).getByRole('button', { name: 'Theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await header(page).getByRole('button', { name: 'Theme' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeChecked();
  });

  test('W07 AS-07: skip link is first and moves focus to main; in-app navigation focuses the new h1', async ({ page }, testInfo) => {
    testInfo.skip(onlyDesktop(testInfo), 'desktop layout');
    await page.goto('/privacy');
    await expect(page.locator(':focus')).toHaveCount(0);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main-content')).toBeFocused();
    // in-app navigation through the footer
    await page.getByRole('contentinfo').getByRole('link', { name: 'Terms' }).click();
    await expect(page).toHaveURL(/\/terms/);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  });

  test('W07 AS-08: footer links reach terms, privacy, docs', async ({ page }, testInfo) => {
    testInfo.skip(onlyDesktop(testInfo), 'desktop layout');
    await page.goto('/');
    const footer = page.getByRole('contentinfo');
    await expect(footer.getByText('Marketplace is a portfolio project: no real goods are sold and no real payments are taken.')).toBeVisible();
    await expect(footer.getByRole('navigation', { name: 'Footer' })).toBeVisible();
    for (const [name, url] of [
      ['Terms', /\/terms$/],
      ['Privacy', /\/privacy$/],
      ['API docs', /\/developers\/docs$/],
    ] as const) {
      await page.goto('/');
      await page.getByRole('contentinfo').getByRole('link', { name }).click();
      await expect(page).toHaveURL(url);
    }
  });

  test('W07 AS-09: an unknown address shows the not-found page inside the frame', async ({ page }) => {
    const response = await page.goto('/definitely/not/a/page');
    expect(response!.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
    await expect(page.getByRole('link', { name: 'Browse products' })).toHaveAttribute('href', '/search');
    await expect(header(page)).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();
    await expect(page).toHaveTitle('Page not found · Marketplace');
    await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
    await expect(page.locator('body')).not.toContainText('definitely');
  });

  // AS-12's slow-page journey is not automated: every route is a cheap client page, so none stays in its loading state
  // long enough to observe, and the browser cannot slow a server-side render. See gaps.md "Not automated".
});
