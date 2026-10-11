import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * VP rows of W01 (AS-05, AS-08, AS-14, AS-15, AS-38, AS-66): the auth pages' layout states at the phone (390 x 844) and
 * desktop (1280 x 800) widths. The backend is stubbed with `page.route` (layout only, no behaviour); animations are off
 * (config); every state gets an axe scan (serious/critical = 0) and a 320 px no-horizontal-scroll check.
 */

async function stubBackend(page: Page) {
  // The navbar asks for the session; the pages are served as anonymous (their server guard sees no cookie).
  await page.route('**/api/bff/session', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'unauthenticated' }) });
    }
    return route.fallback();
  });
}

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}

/** The layout rules every state shares: serious axe violations = 0 and nothing scrolls sideways at 320 px. */
async function expectAccessibleAndContained(page: Page) {
  expect(await seriousViolations(page)).toEqual([]);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  // The page content (the card, not the site header W07 owns) must fit the width.
  const overflowing = await page.evaluate(() => {
    const root = document.querySelector('#main-content');
    if (!root) return ['#main-content missing'];
    return [...root.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
      .map((el) => `${el.tagName}.${String((el as HTMLElement).className).slice(0, 40)}`);
  });
  expect(overflowing).toEqual([]);
  if (original) await page.setViewportSize(original);
}

const main = (page: Page) => page.locator('#main-content');

/** Typing before React attaches its handlers would be wiped by the first render: wait until the form is hydrated. */
const hydrated = (page: Page) =>
  page.waitForFunction(() => {
    const form = document.querySelector('#main-content form');
    return !!form && Object.keys(form).some((key) => key.startsWith('__reactProps'));
  });

test.describe('Auth pages layout', () => {
  test.beforeEach(async ({ page }) => {
    await stubBackend(page);
  });

  test('W01 AS-05 VP register: structure, field order and layout', async ({ page }) => {
    await page.goto('/register');
    await expect(page).toHaveTitle('Create account · Marketplace');
    await expect(page.getByRole('heading', { level: 1, name: 'Create account' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
    await expect(main(page)).toHaveScreenshot('register.png');
    await expectAccessibleAndContained(page);
  });

  test('W01 AS-14 VP login: structure, no Remember me or GitHub, layout', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle('Sign in · Marketplace');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(page.getByText(/remember me/i)).toHaveCount(0);
    await expect(page.getByText(/github/i)).toHaveCount(0);
    await expect(main(page)).toHaveScreenshot('login.png');
    await expectAccessibleAndContained(page);
  });

  test('W01 AS-08 VP login: credentials error', async ({ page }) => {
    await page.route('**/api/bff/session', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'invalid_credentials' }) });
    });
    await page.goto('/login');
    await hydrated(page);
    await page.getByLabel('Email').fill('someone@example.com');
    await page.getByLabel('Password', { exact: true }).fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'The email or password is incorrect.' })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
    await expect(main(page)).toHaveScreenshot('login-credentials-error.png');
    await expectAccessibleAndContained(page);
  });

  test('W01 AS-15 VP login: notice banner', async ({ page }) => {
    await page.goto('/login?notice=registered');
    const banner = page.getByRole('status').filter({ hasText: 'Thanks for signing up.' });
    await expect(banner).toBeVisible();
    await expect(main(page)).toHaveScreenshot('login-notice-banner.png');
    await expectAccessibleAndContained(page);
  });

  test('W01 AS-38 VP mfa: structure and layout', async ({ page }) => {
    await page.goto('/login/mfa?returnTo=%2Faccount%2Fsecurity');
    await expect(page).toHaveTitle('Two-step verification · Marketplace');
    await expect(page.getByRole('heading', { level: 1, name: 'Two-step verification' })).toBeVisible();
    await expect(page.getByLabel('Authentication code')).toBeVisible();
    await expect(main(page)).toHaveScreenshot('mfa.png');
    await expectAccessibleAndContained(page);
  });
});
