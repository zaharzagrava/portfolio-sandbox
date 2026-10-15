import { expect, test } from '@playwright/test';
import { PROD_PORT } from '../playwright.config';
import { expectNoCspViolations, headersOf } from './helpers';

// These checks need the production build (real headers, no dev-only allowances): Playwright starts it on its own port
// when this file is targeted (see playwright.config.ts).
test.use({ baseURL: `http://localhost:${PROD_PORT}` });

const nonceOf = (policy: string | undefined) => /'nonce-([^']+)'/.exec(policy ?? '')?.[1];

test.describe('W07 security headers', () => {
  test('W07 AS-16: every document response carries a nonce policy (pages, 404, error page; 100 distinct nonces)', async ({ request }) => {
    const nonces = new Set<string>();
    for (const path of ['/', '/privacy', '/terms', '/search', '/does-not-exist', '/products/not-a-real-product']) {
      const { headers } = await headersOf(request, path);
      const policy = headers['content-security-policy'];
      expect(policy, path).toBeTruthy();
      const scriptSrc = /(?:^|; )script-src ([^;]*)/.exec(policy)![1];
      expect(scriptSrc, path).toMatch(/^'self' 'nonce-[^']{20,}' 'strict-dynamic'$/);
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain('upgrade-insecure-requests');
      expect(nonceOf(policy)).toBeTruthy();
    }
    for (let i = 0; i < 100; i++) {
      const { headers } = await headersOf(request, '/privacy');
      nonces.add(nonceOf(headers['content-security-policy'])!);
    }
    expect(nonces.size).toBe(100);
  });

  // Includes the routes with dynamic segments, which Next may prerender a fallback shell for.
  for (const path of ['/privacy', '/', '/products/some-product', '/dashboard/seller/some-shop/developers/api-keys']) {
    test(`W07 AS-16: the nonce reaches the scripts of the document (${path})`, async ({ request }) => {
      const res = await request.get(path);
      const nonce = nonceOf(res.headers()['content-security-policy'])!;
      const html = await res.text();
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) expect(script, script).toContain(`nonce="${nonce}"`);
    });
  }

  test('W07 AS-17: main journeys raise no CSP violation', async ({ page }) => {
    const done = await expectNoCspViolations(page);
    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible();
    // theme switch
    await page.getByRole('button', { name: 'Theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    // browse, search, a product (when the catalogue has one), docs viewer, error page
    await page.goto('/search');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.goto('/developers/docs');
    await expect(page.getByRole('banner')).toBeVisible();
    await page.goto('/definitely-not-a-page');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    // client-side navigation keeps working under the policy
    await page.getByRole('link', { name: 'Go to home' }).click();
    await expect(page).toHaveURL(/\/$/);
    await done();
  });

  test('W07 AS-18: payment hosts only on /checkout/pay', async ({ request }) => {
    const pay = (await headersOf(request, '/checkout/pay/order-1')).headers['content-security-policy'];
    const home = (await headersOf(request, '/')).headers['content-security-policy'];
    for (const directive of ['script-src', 'connect-src', 'frame-src']) {
      expect(pay).toMatch(new RegExp(`${directive}[^;]*https://pay\\.example\\.test`));
      expect(home).not.toMatch(new RegExp(`${directive}[^;]*pay\\.example\\.test`));
    }
    expect(home).toContain("frame-src 'none'");
    expect(pay).not.toContain('*');
  });

  test('W07 AS-19: static headers present; no-referrer on reset and invites; no X-Powered-By', async ({ request }) => {
    for (const path of ['/', '/privacy', '/does-not-exist', '/dashboard']) {
      const { headers } = await headersOf(request, path);
      expect(headers['x-content-type-options'], path).toBe('nosniff');
      expect(headers['x-frame-options'], path).toBe('DENY');
      expect(headers['permissions-policy'], path).toBe('camera=(), microphone=(), payment=(), geolocation=(self)');
      expect(headers['cross-origin-opener-policy'], path).toBe('same-origin-allow-popups');
      expect(headers['strict-transport-security'], path).toBe('max-age=63072000; includeSubDomains');
      expect(headers['x-powered-by'], path).toBeUndefined();
      expect(headers['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
    }
    for (const path of ['/reset-password', '/invites/some-token', '/invites/some-token/accept']) {
      const { headers } = await headersOf(request, path);
      expect(headers['referrer-policy'], path).toBe('no-referrer');
    }
  });

  test('W07 AS-20: signed-in areas are no-store; public pages are not', async ({ request }) => {
    for (const path of ['/dashboard', '/orders', '/account/security', '/checkout', '/cart', '/chat', '/admin/feature-flags', '/invites/tok']) {
      const { headers } = await headersOf(request, path);
      expect(headers['cache-control'], path).toContain('no-store');
    }
    for (const path of ['/', '/search', '/privacy', '/terms', '/developers/docs']) {
      const { headers } = await headersOf(request, path);
      // Next sets its own `private, no-cache, no-store` on dynamic documents; the rule here is that we do not add it.
      expect(headers['cache-control'] ?? '', path).not.toMatch(/^no-store$/);
    }
  });

  test('W07 AS-41: /health answers ok, uncached, without the document policy', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(res.headers()['content-security-policy']).toBeUndefined();
  });

  test('W07 AS-21: the policy names the same-origin report endpoint', async ({ request }) => {
    const { headers } = await headersOf(request, '/');
    expect(headers['content-security-policy']).toContain('report-uri /api/csp-reports');
    expect(headers['content-security-policy']).toContain('report-to csp-endpoint');
    expect(headers['reporting-endpoints']).toBe('csp-endpoint="/api/csp-reports"');
  });
});
