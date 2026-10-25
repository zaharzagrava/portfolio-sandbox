import { expect, test, type Page } from '@playwright/test';

const DESCRIPTION_URL = '**/api/developers/openapi.json';
const UNAVAILABLE = 'The API reference is temporarily unavailable.';

/** Script URLs a page asks for while it loads. */
async function scriptsLoadedBy(page: Page, path: string): Promise<string[]> {
  const urls = new Set<string>();
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') urls.add(response.url());
  });
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  return [...urls];
}

test.describe('W07 developer docs @desktop', () => {
  test('W07 AS-27: operations are listed, expand and collapse', async ({ page }) => {
    await page.goto('/developers/docs');
    await expect(page.getByRole('heading', { level: 1, name: 'API documentation' })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('banner')).toHaveCount(1);
    const operations = page.getByRole('heading', { level: 2, name: 'Operations' });
    await expect(operations).toBeVisible();
    const expander = page.getByRole('button', { name: /GET\s*\/v1\/products/ }).first();
    await expect(expander).toBeVisible({ timeout: 15_000 });
    await expect(expander).toHaveAttribute('aria-expanded', 'false');
    await expander.click();
    await expect(expander).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('region', { name: /GET\s*\/v1\/products/ }).first().getByText(/Required scope/)).toBeVisible();
    await expander.click();
    await expect(expander).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('heading', { level: 3 }).first()).toBeVisible();
  });

  test('W07 AS-29: page makes one data request and has no try-it-out', async ({ page }) => {
    const descriptionRequests: string[] = [];
    const apiOperationRequests: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === '/api/developers/openapi.json') descriptionRequests.push(request.url());
      else if (/^\/(api\/)?v1\//.test(pathname)) apiOperationRequests.push(request.url());
    });
    await page.goto('/developers/docs');
    const expander = page.getByRole('button', { name: /GET\s*\/v1\/products/ }).first();
    await expect(expander).toBeVisible({ timeout: 15_000 });
    await expander.click();
    await page.getByRole('button', { name: /POST\s*\/v1\/products/ }).first().click();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/try it out/i)).toHaveCount(0);
    await expect(page.locator('#main-content form')).toHaveCount(0);
    await expect(page.locator('#main-content').getByRole('button', { name: /execute|send request/i })).toHaveCount(0);
    expect(descriptionRequests).toHaveLength(1);
    expect(descriptionRequests[0]).toMatch(/^http:\/\/localhost:3000\//); // same origin as the page
    expect(apiOperationRequests).toEqual([]);
  });

  test('W07 AS-30: viewer chunk is not downloaded by other pages', async ({ page, browser }) => {
    const docsScripts = await scriptsLoadedBy(page, '/developers/docs');
    await expect(page.getByRole('button', { name: /GET\s*\/v1\/products/ }).first()).toBeVisible({ timeout: 15_000 });

    // The viewer's own code is the script that carries its unavailable-state text.
    const viewer: string[] = [];
    for (const url of docsScripts) {
      const body = await (await page.request.get(url)).text();
      if (body.includes(UNAVAILABLE)) viewer.push(url);
    }
    expect(viewer.length, 'the docs page loads a script that contains the viewer').toBeGreaterThan(0);

    const other = await browser.newPage();
    for (const path of ['/', '/privacy']) {
      const loaded = await scriptsLoadedBy(other, path);
      for (const url of viewer) expect(loaded, `${path} must not download ${url}`).not.toContain(url);
    }
    await other.close();
  });

  test('W07 AS-28: an unavailable description shows the message and Try again brings the reference back in place', async ({ page }) => {
    await page.route(DESCRIPTION_URL, (route) =>
      route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ status: 503, code: 'service_unavailable', requestId: 'req-w07-docs' }) }),
    );
    await page.goto('/developers/docs');
    await expect(page.getByRole('heading', { level: 1, name: 'API documentation' })).toBeVisible();
    await expect(page.getByText(UNAVAILABLE)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/req-w07-docs/)).toBeVisible();
    // the static text stays readable
    await expect(page.getByRole('heading', { level: 2, name: 'Authentication' })).toBeVisible();
    await page.unroute(DESCRIPTION_URL);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('button', { name: /GET\s*\/v1\/products/ }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(UNAVAILABLE)).toHaveCount(0);
  });
});
