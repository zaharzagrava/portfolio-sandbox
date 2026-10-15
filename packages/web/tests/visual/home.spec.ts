import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousViolations } from './axe';
import { productId } from '../helpers';

/**
 * VH rows of W02 (AS-01, AS-04, AS-75): the home page's layout at the phone (390 x 844) and desktop (1280 x 800) widths.
 * The rail's first view is rendered on the server, so these run against the seeded stack; the screenshot covers only the
 * static hero, whose content does not depend on the data.
 */

const top = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())?.y ?? Number.NaN;

test.describe('Home layout', () => {
  test.beforeEach(async () => {
    await productId(); // the catalogue is indexed, so the rail has products
  });

  test('home: shell and rail, region order', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('home-products').getByRole('link').first()).toBeVisible();

    // Order of regions: h1, search box, rail heading, first card, view all, showcase.
    const y = {
      h1: await top(page, 'h1'),
      box: await top(page, '[role="combobox"]'),
      rail: await top(page, '#trending-heading'),
      card: await top(page, '[data-testid="home-products"] a'),
      showcase: await top(page, '#showcase-heading'),
    };
    expect(y.h1).toBeLessThan(y.box);
    expect(y.box).toBeLessThan(y.rail);
    expect(y.rail).toBeLessThan(y.card);
    expect(y.card).toBeLessThan(y.showcase);
    await expect(page.getByRole('link', { name: 'View all' })).toBeVisible();
  });

  test('home: desktop four columns and mobile two columns', async ({ page }, info) => {
    await page.goto('/');
    const grid = page.getByTestId('home-products');
    await expect(grid.getByRole('link').first()).toBeVisible();
    // The grid's own column count, whatever the number of products the rail has today.
    const columns = await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(info.project.name === 'mobile' ? 2 : 4);
  });

  test('home: the search box is full width of its column and the shortcut row never scrolls the page', async ({ page }) => {
    await page.goto('/');
    const box = await page.getByRole('combobox', { name: 'Search products' }).boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.width).toBeGreaterThan(Math.min(viewport.width - 64, 400));
    expect(box!.width).toBeLessThanOrEqual(640 + 1); // max 40 rem
    await expectNoHorizontalScroll(page);
  });

  test('home: focus order is skip link, search box, then the rail cards, then the showcase', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('home-products').getByRole('link').first()).toBeVisible();
    const seen: string[] = [];
    for (let step = 0; step < 40; step++) {
      await page.keyboard.press('Tab');
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return `${el?.tagName}|${el?.getAttribute('role') ?? ''}|${(el?.textContent ?? '').trim().slice(0, 30)}|${el?.getAttribute('href') ?? ''}`;
        }),
      );
    }
    const index = (pattern: RegExp) => seen.findIndex((entry) => pattern.test(entry));
    expect(seen[0]).toMatch(/Skip to main content/i);
    const box = index(/\|combobox\|/);
    const firstCard = index(/\/products\/[0-9a-f-]{36}$/);
    const viewAll = index(/View all/);
    expect(box).toBeGreaterThan(0);
    expect(firstCard).toBeGreaterThan(box);
    expect(viewAll).toBeGreaterThan(box);
  });

  test('home: no horizontal scroll at 320 px and no serious accessibility violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('home-products').getByRole('link').first()).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.setViewportSize({ width: 320, height: 700 });
    await expectNoHorizontalScroll(page);
  });

  test.describe('hero', () => {
    // The page's CSP (style-src 'self' + nonce) refuses a style tag added from the test; only this screenshot test lifts it,
    // so every other test in the file still runs against the real policy.
    test.use({ bypassCSP: true });

    test('home: the hero', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // The shortcut row depends on the catalogue's categories, and so does its height: a mask would still move everything below it,
      // so the row is taken out of the layout and the screenshot is the same on an empty stack and on a used one.
      await page.addStyleTag({ content: 'nav[aria-label="Categories"] { display: none !important; }' });
      await expect(page.locator('main section').first()).toHaveScreenshot('home-hero.png');
    });
  });
});
