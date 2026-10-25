import { expect, test } from '@playwright/test';
import { SEED, login, resetRateLimits, signOut } from './helpers';

/**
 * The browser session through the BFF (S48 follow-up, W01 AS-28/29): sign in sets an HttpOnly session cookie and a readable
 * CSRF cookie; a forwarded call works with the cookie alone; a state-changing request without the CSRF proof is refused;
 * sign-out clears both cookies. Happy paths only; the guard rules are proven in the backend specs.
 */
test.describe('BFF session @desktop', () => {
  test('sign in sets the cookies, forwarded calls work, CSRF is enforced, sign out clears them', async ({ page, context }) => {
    await resetRateLimits();
    await login(page, SEED.seller, SEED.password);

    await test.step('cookies: HttpOnly session, script-readable CSRF', async () => {
      const cookies = await context.cookies();
      const session = cookies.find((cookie) => cookie.name === '__Host-bff-session');
      const csrf = cookies.find((cookie) => cookie.name === '__Host-bff-csrf');
      expect(session?.httpOnly).toBe(true);
      expect(session?.secure).toBe(true);
      expect(csrf?.httpOnly).toBe(false);
      expect(await page.evaluate(() => document.cookie)).toContain('__Host-bff-csrf=');
      expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-bff-session');
    });

    await test.step('an authenticated forwarded call works with the cookie alone', async () => {
      // The two-step status needs a signed-in member: the BFF forwarder turns the cookie into the bearer token on the server.
      const response = await page.request.get('/api/auth/mfa');
      expect(response.status(), await response.text()).toBe(200);
    });

    await test.step('a state-changing request without the CSRF proof is refused', async () => {
      const response = await page.request.post('/api/auth/logout-all', { data: {} });
      expect(response.status()).toBe(403);
      expect(((await response.json()) as { code?: string }).code).toBe('csrf_invalid');
    });

    await test.step('logout clears both cookies', async () => {
      await signOut(page);
      const names = (await context.cookies()).map((cookie) => cookie.name);
      expect(names).not.toContain('__Host-bff-session');
      expect(names).not.toContain('__Host-bff-csrf');
      const after = await page.request.get('/api/auth/mfa');
      expect(after.status()).toBe(401);
    });
  });
});
