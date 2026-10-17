import { expect, test, type Page } from '@playwright/test';
import { login, productId, register, SEED, signOut } from './helpers';
import { seriousViolations } from './visual/axe';

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
    await expect(banner.getByRole('combobox', { name: 'Search products' })).toBeVisible();
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

  test('W07 AS-23: privacy page reachable from the footer, with its sections and a working "On this page" link', async ({ page }, testInfo) => {
    await page.goto('/');
    await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeVisible();
    await expect(page).toHaveTitle('Privacy policy · Marketplace');
    await expect(page.getByText(/^Last updated: \d{4}-\d{2}-\d{2}$/)).toBeVisible();
    for (const name of ['What we store', 'Cookies and browser storage', 'Who receives data', 'Your choices', 'Contact']) {
      await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
    }
    if (testInfo.project.name === 'desktop') {
      await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Your choices' }).click();
      await expect(page).toHaveURL(/#your-choices$/);
      await expect(page.getByRole('heading', { level: 2, name: 'Your choices' })).toBeFocused();
    } else {
      await page.locator('details', { hasText: 'On this page' }).getByText('On this page').click();
      await page.locator('details').getByRole('link', { name: 'Contact' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Contact' })).toBeFocused();
    }
  });

  test('W07 AS-24: terms page reachable from the footer, with its sections', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('contentinfo').getByRole('link', { name: 'Terms' }).click();
    await expect(page).toHaveURL(/\/terms$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeVisible();
    await expect(page).toHaveTitle('Terms of service · Marketplace');
    for (const name of ['What this is', 'Accounts', 'Acceptable use', 'The API', 'No warranty', 'Changes', 'Contact']) {
      await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
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

  test('W07 AS-01: the header hydrates without a mismatch, for a visitor and for a member', async ({ page }) => {
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    const hydrationProblems = () => problems.filter((text) => /hydrat|didn't match|did not match/i.test(text));

    for (const path of ['/privacy', '/', '/search', '/invites/abc', '/nothing/at/all', `/products/${await productId()}`]) {
      await page.goto(path);
      await expect(header(page).getByRole('button', { name: 'Theme' })).toBeVisible();
      await page.waitForTimeout(1_000);
      expect(hydrationProblems(), `visitor on ${path}`).toEqual([]);
    }

    await register(page);
    await page.goto('/privacy');
    await expect(header(page).getByRole('button', { name: /Notifications/i })).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(hydrationProblems(), 'member').toEqual([]);
  });

  test('W07 AS-34: titles follow the pattern and robots lists private areas', async ({ page, request }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Marketplace');
    await page.goto('/privacy');
    await expect(page).toHaveTitle('Privacy policy · Marketplace');
    await page.goto('/terms');
    await expect(page).toHaveTitle('Terms of service · Marketplace');
    await page.goto('/definitely/not/a/page');
    await expect(page).toHaveTitle('Page not found · Marketplace');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /width=device-width/);

    const robots = await request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    const body = await robots.text();
    expect(body).toMatch(/^User-Agent: \*/im);
    expect(body).toMatch(/^Allow: \/$/m);
    for (const path of ['/api/', '/dashboard/', '/account/', '/admin/', '/checkout/', '/cart', '/chat', '/invites/']) {
      expect(body, path).toContain(`Disallow: ${path}\n`);
    }
    expect(body).not.toMatch(/Disallow: \/(privacy|terms|search|products)/);

    // private areas also say so in a header
    const account = await request.get('/account/security', { maxRedirects: 0 });
    expect(account.headers()['x-robots-tag']).toBe('noindex');
    const publicPage = await request.get('/privacy');
    expect(publicPage.headers()['x-robots-tag']).toBeUndefined();
  });

  test('W07 AS-35: navigating the site reports page names, never addresses', async ({ page }) => {
    test.setTimeout(120_000); // five batches, each leaves on the 5 s timer
    const pages: string[] = [];
    await page.route('**/api/events', async (route) => {
      const posted = route.request().postData();
      try {
        for (const event of JSON.parse(posted ?? '{}').events ?? []) if (event.name === 'page_view') pages.push(event.page);
      } catch {
        // not a batch
      }
      await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
    });
    const id = await productId();
    const token = 'inv_SECRETtokenvalue1234567890';
    // a signed-out visitor to /invites/{token} is sent to sign-in (W04 AS-80), so the invite page is reported by a member
    await register(page);
    // Events leave in batches every 5 s (or by beacon when the page is hidden, which a test cannot observe), so each
    // address is loaded and its batch awaited before the next one.
    const reportedBy = async (path: string, expected: string) => {
      const before = pages.length;
      await page.goto(path);
      await expect.poll(() => pages.slice(before), { timeout: 20_000 }).toContain(expected);
    };
    await reportedBy('/', '/');
    await reportedBy(`/products/${id}?tab=discussions#reviews`, '/products/:slug');
    await reportedBy(`/invites/${token}`, '/invites/:token');
    await reportedBy('/nothing/at/all', '/not-found');
    // an in-app navigation (no reload) reports once as well
    await page.goto('/');
    const before = pages.length;
    await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect.poll(() => pages.slice(before), { timeout: 20_000 }).toContain('/privacy');
    expect(pages.slice(before).filter((name) => name === '/privacy')).toHaveLength(1);
    for (const reported of pages) {
      expect(reported).not.toContain(id);
      expect(reported).not.toContain(token);
      expect(reported).not.toMatch(/[?#]/);
    }
  });

  test('W07 AS-20: Back after sign-out shows no private content', async ({ page }) => {
    await register(page);
    await page.goto('/account/security');
    await expect(page.getByRole('heading', { level: 1, name: /security/i })).toBeVisible();
    await signOut(page);
    // Back through every earlier entry: the private page must never come back from a cache.
    for (let step = 0; step < 3; step += 1) {
      await page.goBack().catch(() => null);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByRole('heading', { level: 1, name: /security/i })).toHaveCount(0);
      if (/\/account\/security/.test(page.url())) await expect(page).toHaveURL(/\/login/);
    }
  });

  test('W07 AS-31: no horizontal scroll at 320 px on the frame, legal pages, docs and not-found', async ({ page }, testInfo) => {
    testInfo.skip(onlyMobile(testInfo), 'one pass is enough: the width is set by the test');
    await page.setViewportSize({ width: 320, height: 700 });
    for (const path of ['/', '/privacy', '/terms', '/developers/docs', '/definitely/not/a/page']) {
      await page.goto(path);
      await expect(header(page)).toBeVisible();
      if (path === '/developers/docs') await expect(page.getByRole('button', { name: /GET\s*\/v1\/products/ }).first()).toBeVisible({ timeout: 15_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
      // targets in the header and the footer are at least 44 x 44 px at this width
      const small = await page.evaluate(() => {
        const targets = [...document.querySelectorAll('header a, header button, footer a')].filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        });
        return targets
          .filter((el) => {
            const box = el.getBoundingClientRect();
            return box.width < 43.5 || box.height < 43.5;
          })
          .map((el) => `${el.tagName} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
      });
      expect(small, `${path}: targets under 44 px`).toEqual([]);
    }
    // a member's header holds the bell instead of the log-in icon: same room
    await register(page);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/privacy');
    await expect(header(page).getByRole('button', { name: /Notifications/i })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `member header scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
  });

  test('W07 AS-32: keyboard walk follows the frame order; menus return focus on Escape', async ({ page }, testInfo) => {
    testInfo.skip(onlyDesktop(testInfo), 'desktop layout');
    await page.goto('/privacy');
    await expect(header(page).getByRole('link', { name: 'Log in' })).toBeVisible();
    const names: string[] = [];
    for (let step = 0; step < 10; step += 1) {
      await page.keyboard.press('Tab');
      names.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
        }),
      );
    }
    // the search box is its input and its submit button
    expect(names.slice(0, 9)).toEqual(['Skip to main content', 'Marketplace home', 'Browse', 'Developers', 'Search products', 'Search', 'AI Assistant', 'Theme', expect.stringMatching(/^Cart/)]);
    expect(names[9]).toMatch(/Log in/);
    // the page content comes next, the footer last
    const order = await page.evaluate(() => {
      const first = (selector: string) => document.querySelector(selector)?.compareDocumentPosition(document.querySelector('footer a')!);
      return { mainBeforeFooter: Boolean((first('#main-content') ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    expect(order.mainBeforeFooter).toBe(true);

    // the theme menu returns focus to its trigger on Escape
    const theme = header(page).getByRole('button', { name: 'Theme' });
    await theme.click();
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(theme).toBeFocused();
    // icon-only controls have names; the active link is exposed
    await page.goto('/search');
    await expect(header(page).getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Browse' })).toHaveAttribute('aria-current', 'page');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`W07 AS-33: no serious or critical accessibility violation on the frame and the W07 pages (${scheme})`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'no-preference' });
      const failures: string[] = [];
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        for (const path of ['/', '/privacy', '/terms', '/developers/docs', '/definitely/not/a/page']) {
          await page.goto(path);
          await expect(header(page)).toBeVisible();
          if (path === '/developers/docs') await expect(page.getByRole('button', { name: /GET\s*\/v1\/products/ }).first()).toBeVisible({ timeout: 15_000 });
          for (const violation of await seriousViolations(page)) failures.push(`${scheme} ${width}px ${path}: ${violation}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  // AS-12's slow-page journey is not automated: every route is a cheap client page, so none stays in its loading state
  // long enough to observe, and the browser cannot slow a server-side render. See gaps.md "Not automated".
});
