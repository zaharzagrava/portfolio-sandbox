import { test, expect, type Page } from '@playwright/test';
import { NEW_USER_PASSWORD, register, resetRateLimits, signOut, uniqueEmail, waitForForm } from './helpers';

const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;

/** The navbar tells the truth: the account menu (desktop) or the phone menu's account group shows the member's e-mail. */
async function expectSignedInAs(page: Page, email: string) {
  await expect(page.getByRole('link', { name: 'Log in' })).toHaveCount(0);
  if (isDesktop(page)) {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.getByRole('menu').getByText(email)).toBeVisible();
    await page.keyboard.press('Escape');
    return;
  }
  await page.getByRole('button', { name: 'Open menu' }).click();
  const sheet = page.getByRole('dialog', { name: 'Menu' });
  await expect(sheet.getByRole('group', { name: 'Account' }).getByText(email)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
}

/** W01 AS-01/06/19/21/24/27/29: the happy path against the real backend (edge cases live in the unit and API specs). */
test.describe('Authentication', () => {
  test('register, sign in, stay signed in, sign out', async ({ page, context }) => {
    const email = uniqueEmail();
    const authorizationHeaders: string[] = [];
    page.on('request', (request) => {
      if (request.headers()['authorization']) authorizationHeaders.push(request.url());
    });

    await test.step('a guarded page sends an anonymous visitor to sign in (AS-27)', async () => {
      await page.goto('/account/security');
      await expect(page).toHaveURL('http://localhost:3000/login?returnTo=%2Faccount%2Fsecurity');
    });

    await test.step('register ends on the sign-in page, not signed in (AS-01)', async () => {
      await resetRateLimits();
      await page.goto('/register');
      await waitForForm(page);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(NEW_USER_PASSWORD);
      await page.getByLabel('Confirm password', { exact: true }).fill(NEW_USER_PASSWORD);
      await page.getByRole('checkbox', { name: /I agree to the Terms/ }).click();
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page).toHaveURL('http://localhost:3000/login?notice=registered');
      await expect(page.getByRole('status').filter({ hasText: 'Thanks for signing up.' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Log in' }).first()).toBeVisible();
      expect(page.url()).not.toContain(email);
    });

    await test.step('sign in lands on returnTo with the account menu (AS-06, AS-19)', async () => {
      await page.goto('/login?returnTo=%2Faccount%2Fsecurity');
      await waitForForm(page);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(NEW_USER_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL('http://localhost:3000/account/security');
      await expectSignedInAs(page, email);
    });

    await test.step('a reload and a second page in the same context stay signed in (AS-21)', async () => {
      await page.reload();
      await expectSignedInAs(page, email);
      const second = await context.newPage();
      await second.goto('/');
      await expectSignedInAs(second, email);
      await second.close();
    });

    await test.step('no token is script-readable and none is sent (AS-29)', async () => {
      const exposed = await page.evaluate(async () => ({
        local: Object.keys(window.localStorage),
        session: Object.keys(window.sessionStorage),
        cookie: document.cookie,
        databases: (await indexedDB.databases?.())?.map((db) => db.name) ?? [],
        url: location.href,
      }));
      expect(exposed.local).toEqual([]);
      expect(exposed.session).toEqual([]);
      // the page view (W02) sets `anonymous_id`, a random visitor id that is not a credential; the only other cookie is the CSRF one
      expect(exposed.cookie.split(';').map((entry) => entry.trim().split('=')[0]).sort()).toEqual(['__Host-bff-csrf', 'anonymous_id']);
      // (the dev server's own `__next_debug_channel` database is not ours)
      expect(exposed.databases.filter((name) => /token|auth|session|bearer|credential/i.test(name ?? ''))).toEqual([]);
      expect(exposed.url).not.toMatch(/token|bearer|eyJ/i);
      const cookies = await context.cookies();
      expect(cookies.find((cookie) => cookie.name === '__Host-bff-session')?.httpOnly).toBe(true);
      expect(authorizationHeaders).toEqual([]);
    });

    await test.step('sign out lands on the sign-in notice, anonymous again (AS-24)', async () => {
      await signOut(page);
      await expect(page.getByRole('status').filter({ hasText: "You've been signed out." })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Log in' }).first()).toBeVisible();
      await page.goto('/account/security');
      await expect(page).toHaveURL('http://localhost:3000/login?returnTo=%2Faccount%2Fsecurity');
    });
  });

  test('signing out in one tab signs the other tab out (AS-22)', async ({ page, context }) => {
    const { email } = await register(page);
    await expectSignedInAs(page, email);
    const other = await context.newPage();
    await other.goto('/');
    await expectSignedInAs(other, email);

    await signOut(page);
    await expect(other.getByRole('link', { name: 'Log in' }).first()).toBeVisible({ timeout: 1_000 });
    await other.close();
  });
});
