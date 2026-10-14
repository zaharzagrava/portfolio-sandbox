import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { buildEmbedCsp } from '../../backend/libs/domains/developer-platform/domain/frame-policy';
import { loaderScript } from '../../edge-be/src/widget-loader';
import { PROD_PORT } from '../playwright.config';

// The bundle is checked on the production build (real headers); the journeys load it from there.
test.use({
  baseURL: `http://localhost:${PROD_PORT}`,
  // The shop's page and the embed document are fulfilled by the test, so Chromium has no IP address to classify them by and
  // treats them as public; it would then refuse their requests to the loopback servers of this test stack (Local Network
  // Access). Real deployments serve all of them from public addresses.
  launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests'] },
});

const WEB = `http://localhost:${PROD_PORT}`;
const API = 'http://localhost:8000';
const HOST = 'https://widget-host.example.test';
const KEY = 'pk_live_abcdefghijklmnopqrstuvwx';
const PRODUCT = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const EMAIL = 'buyer@example.com';
const FRAME = 'iframe[title="Marketplace checkout"]';

/**
 * The S44 side, played by the test: the shop's page (with the real loader script), the widget `config` and `identify`
 * answers, and the embed document built exactly as `WidgetPublicService.embed` builds it, with the real
 * `buildEmbedCsp` policy. The bundle is the web app's own, loaded cross-origin from the production server, which is what
 * `WIDGET_APP_BUNDLE_URL` makes the embed document do. (The same journey against the dev stack's real widget routes needs
 * the S44 tables: see specs/UNVERIFIED.md.)
 */
async function playShop(page: Page, options: { identify?: { status: number; body?: unknown }; cspViolations?: string[] } = {}) {
  const identifyCalls: unknown[] = [];
  await page.route(`${HOST}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/loader.js') return route.fulfill({ contentType: 'application/javascript', body: loaderScript(API) });
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Shop</title><main><div data-marketplace-widget></div><script src="/loader.js" data-site-key="${KEY}"></script></main>`,
    });
  });
  await page.route(`${API}/api/widget/v1/config*`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': HOST, Vary: 'Origin' },
      body: JSON.stringify({ version: 'v1', shop: { name: 'Shop' }, theme: {}, products: [{ id: PRODUCT, title: 'Lantern', price: { amountMinor: 1999, currency: 'USD' }, inStock: true }], checkoutUrl: `${WEB}/embed/checkout` }),
    }),
  );
  await page.route(`${API}/api/widget/v1/embed*`, (route) => {
    const nonce = randomBytes(18).toString('base64url');
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>Checkout</title></head><body>` +
      `<div id="widget-root" data-site="${encodeURIComponent(KEY)}"></div>` +
      `<script nonce="${nonce}" src="${WEB}/widget/v1/app.js"></script></body></html>`;
    return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': buildEmbedCsp({ nonce, origins: [HOST] }) }, body: html });
  });
  await page.route(`${API}/api/widget/v1/identify`, (route) => {
    identifyCalls.push(route.request().postDataJSON());
    const answer = options.identify ?? { status: 200, body: { widgetToken: 'w.t', expiresIn: 900, customer: { id: 'cust-42', email: EMAIL } } };
    return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? { status: answer.status }) });
  });
  if (options.cspViolations) {
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text())) options.cspViolations!.push(message.text());
    });
  }
  await page.goto(`${HOST}/`);
  const button = page.locator('[data-marketplace-widget] button[data-product]').first();
  await expect(button).toBeEnabled({ timeout: 15_000 });
  return { button, identifyCalls };
}

/**
 * BLOCKED by S44 (questions.md, "Widget checkout application"): the embed document's policy is `default-src 'none'` with no
 * `connect-src`, so the browser refuses the application's call to `identify`; and `identify` itself answers `403
 * origin_not_allowed` to the embed document's own origin. The two tests that need that call switch on by themselves once
 * the policy of `buildEmbedCsp` allows it.
 */
const EMBED_POLICY_ALLOWS_IDENTIFY = /(?:^|; )connect-src [^;]*'self'/.test(buildEmbedCsp({ nonce: 'n'.repeat(24), origins: [HOST] }));
const BLOCKED_BY_S44 = 'blocked: the S44 embed document policy has no connect-src, so the application cannot call identify (questions.md)';

const hostAnswers =(page: Page, token: string | null) =>
  page.evaluate((value) => {
    const w = window as unknown as { MarketplaceWidget: { identify: () => Promise<string | null> }; __asked?: number };
    w.__asked = 0;
    w.MarketplaceWidget.identify = async () => {
      w.__asked = (w.__asked ?? 0) + 1;
      return value;
    };
  }, token);

test.describe('W07 widget checkout application', () => {
  test('W07 AS-39: bundle is served cross-origin with correct headers', async ({ request }) => {
    const response = await request.get('/widget/v1/app.js');
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers['content-type']).toMatch(/^application\/javascript/);
    expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toBeUndefined(); // not a document: no document policy
    const body = await response.text();
    expect(body).not.toMatch(/\beval\s*\(|new Function\s*\(/);
    // the web app's own pages stay unframeable
    const page = await request.get('/privacy');
    expect(page.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  test('W07 AS-40: the iframe application asks the host page who the customer is, then shows "Continue as guest" and closes', async ({ page }) => {
    const { button, identifyCalls } = await playShop(page);
    await hostAnswers(page, null);
    await button.click();
    const frame = page.frameLocator(FRAME);
    await expect(frame.getByText('Continue as guest')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(1);
    expect(identifyCalls).toEqual([]);
    await frame.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(FRAME)).toHaveCount(0);
  });

  test('W07 AS-40: Escape inside the iframe closes it too', async ({ page }) => {
    const { button } = await playShop(page);
    await hostAnswers(page, null);
    await button.click();
    const frame = page.frameLocator(FRAME);
    await expect(frame.getByRole('button', { name: 'Close' })).toBeVisible({ timeout: 20_000 });
    await frame.getByRole('button', { name: 'Close' }).focus();
    await page.keyboard.press('Escape');
    await expect(page.locator(FRAME)).toHaveCount(0);
  });

  test('W07 AS-40: iframe application identifies the customer and closes', async ({ page }) => {
    test.fixme(!EMBED_POLICY_ALLOWS_IDENTIFY, BLOCKED_BY_S44);
    const violations: string[] = [];
    const { button, identifyCalls } = await playShop(page, { cspViolations: violations });
    await hostAnswers(page, 'handoff-token-from-the-shop');
    await button.click();
    const frame = page.frameLocator(FRAME);
    await expect(frame.getByText('Checking your details…')).toHaveCount(0, { timeout: 20_000 });
    // The embed document's own policy must let the application make the identify call (see questions.md, S44 blocker).
    expect(violations, 'the policy of the embed document refused something the application needs').toEqual([]);
    await expect(frame.getByText(`Signed in as ${EMAIL}`)).toBeVisible({ timeout: 20_000 });
    expect(identifyCalls).toEqual([{ key: KEY, token: 'handoff-token-from-the-shop' }]);
    await frame.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(FRAME)).toHaveCount(0);
  });

  test('W07 AS-40: a refused identification shows the one failure text and the iframe can still be closed', async ({ page }) => {
    test.fixme(!EMBED_POLICY_ALLOWS_IDENTIFY, BLOCKED_BY_S44);
    const { button, identifyCalls } = await playShop(page, { identify: { status: 403 } });
    await hostAnswers(page, 'handoff-token-from-the-shop');
    await button.click();
    const frame = page.frameLocator(FRAME);
    await expect(frame.getByText("We couldn't open checkout. Close this window and try again.")).toBeVisible({ timeout: 20_000 });
    // the text is the answer to a request that was made, not the result of the request being blocked
    expect(identifyCalls).toHaveLength(1);
    await frame.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(FRAME)).toHaveCount(0);
  });
});
