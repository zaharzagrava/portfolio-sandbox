import { expect, test, type Page } from '@playwright/test';
import { API_URL, createIsolatedProduct, register } from './helpers';

/**
 * JL (W02 AS-60, AS-61, AS-63; S37 AS-66): a member shares a product, copies the short link and a second browser context, a
 * visitor, opens it. The short domain (`https://mkt.to`) is not reachable from the dev stack, so the visitor follows the
 * origin redirect of the same code (`GET /api/l/{code}`, which the edge would have answered) and lands on the product page
 * with `?ref=<code>`; the web app then holds `__Host-ref` for 30 days, HttpOnly.
 */
/** Presses Share until the dialog is up: a click on the server-rendered button before hydration does nothing. */
async function openShare(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Share this product' });
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.getByRole('button', { name: 'Share' }).click();
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return dialog;
}

test.describe('Share link', () => {
  test('share a product, copy the link and open it as a visitor', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const product = await createIsolatedProduct();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await register(page);

    await page.goto(`/products/${product.id}`);
    const popover = await openShare(page);
    const field = popover.getByRole('textbox', { name: 'Share link' });
    await expect(field).toBeVisible();
    const shortUrl = await field.inputValue();
    expect(shortUrl).toMatch(/^https:\/\/[^/]+\/[0-9A-Za-z]{7}$/);
    await expect(field).toBeFocused();

    await popover.getByRole('button', { name: 'Copy link' }).click();
    await expect(popover.getByText('Link copied.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shortUrl);

    // Closing and reopening shows the same link.
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(page.getByRole('button', { name: 'Share' })).toBeFocused();
    await expect((await openShare(page)).getByRole('textbox', { name: 'Share link' })).toHaveValue(shortUrl);

    // The visitor: a second context with no session opens the link (origin redirect of the same code).
    const code = new URL(shortUrl).pathname.slice(1);
    const redirect = await page.request.get(`${API_URL}/api/l/${code}`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    const location = redirect.headers()['location']!;
    expect(new URL(location).pathname).toBe(`/products/${product.id}`);
    expect(new URL(location).searchParams.get('ref')).toBe(code);

    const visitorContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
    try {
      const visitor = await visitorContext.newPage();
      const captured = visitor.waitForResponse((response) => response.url().endsWith('/api/attribution/ref') && response.request().method() === 'POST');
      await visitor.goto(location);
      expect((await captured).status()).toBe(204);
      await expect(visitor.getByRole('heading', { level: 1, name: product.title })).toBeVisible();

      const cookies = await visitorContext.cookies('http://localhost:3000');
      const ref = cookies.find((cookie) => cookie.name === '__Host-ref');
      expect(ref).toMatchObject({ value: code, httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
      const days = (ref!.expires - Date.now() / 1000) / 86_400;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30.01);
      // Page scripts cannot read it.
      expect(await visitor.evaluate(() => document.cookie)).not.toContain('__Host-ref');

      // Visible effect: none. The visitor sees the product page and no sign of the code.
      await expect(visitor.getByText(code)).toHaveCount(0);
    } finally {
      await visitorContext.close();
    }
  });

  test('a visitor who is not signed in is asked to sign in and no link is created', async ({ page }) => {
    const product = await createIsolatedProduct();
    let created = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/links')) created += 1;
    });
    await page.goto(`/products/${product.id}?tab=details`);
    const popover = await openShare(page);
    await expect(popover.getByText('Sign in to create a share link.')).toBeVisible();
    await expect(popover.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/login?returnTo=${encodeURIComponent(`/products/${product.id}?tab=details`)}`);
    expect(created).toBe(0);
  });
});
