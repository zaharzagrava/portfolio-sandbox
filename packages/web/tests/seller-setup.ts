import { expect, type Page } from '@playwright/test';
import { NEW_USER_PASSWORD, SEED, login, resetRateLimits, sellerCall, uniqueShopName } from './helpers';

/**
 * Opens a shop for `member` through the real API (the same call the open-shop form makes) instead of filling the form.
 * Use it where the shop is only set-up; the form itself is exercised by seller.spec.ts and seller-shop.spec.ts.
 * Same result shape as `openShop`.
 */
export async function openShopByApi(member: { email: string; password?: string }, name = uniqueShopName()): Promise<{ shopId: string; shopName: string }> {
  await resetRateLimits();
  const signedIn = await sellerCall('POST', '/api/auth/login', { email: member.email, password: member.password ?? NEW_USER_PASSWORD });
  expect(signedIn.status).toBe(200);
  const slug = `e2e-shop-${Date.now().toString(36)}${Math.floor(Math.random() * 1e5).toString(36)}`;
  const created = await sellerCall('POST', '/api/shops', { name, slug }, signedIn.data.accessToken.token);
  expect(created.status, `create shop: ${JSON.stringify(created.data)}`).toBe(201);
  return { shopId: created.data.id as string, shopName: name };
}

/** Signs the seeded admin in through the API (the two calls the sign-in form makes) and lands on the flag list. */
export async function adminLoginByApi(page: Page) {
  if (process.env.PW_UI_LOGIN === '1') return login(page, SEED.admin, SEED.password, '/admin/feature-flags');
  await resetRateLimits();
  const signedIn = await page.request.post('/api/bff/session', { data: { email: SEED.admin, password: SEED.password } });
  expect(signedIn.status(), `admin login: ${await signedIn.text()}`).toBeLessThan(300);
  await page.goto('/admin/feature-flags');
}
