import { expect, test, type Page } from '@playwright/test';
import { expectMainFitsWidth, expectNoSeriousViolations } from './axe';
import { SEED, addPageStyle, createIsolatedProduct, productId } from '../helpers';

/**
 * VP rows of W02 (AS-32..AS-34, AS-36..AS-38, AS-75): the product page's layout at the phone (390 x 844) and desktop
 * (1280 x 800) widths against the seeded product. The seed has no images, trending data or recommendations, so these are
 * also the "every optional section missing" states. The 503 and 429 pages need a failing BFF, which a browser test cannot
 * force (the read is made by the server); their copy and layout are covered by `product-unavailable.test.tsx`.
 */

const mobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;
const box = async (page: Page, locator: ReturnType<Page['locator']>) => (await locator.first().boundingBox())!;

test.describe('Product page layout', () => {
  test('product: desktop two columns and mobile single column', async ({ page }) => {
    const id = await productId();
    await page.goto(`/products/${id}`);
    const gallery = page.getByTestId('gallery-placeholder');
    const title = page.getByRole('heading', { level: 1, name: SEED.product });
    await expect(title).toBeVisible();
    const g = await box(page, gallery);
    const t = await box(page, title);
    if (mobile(page)) {
      expect(t.y).toBeGreaterThanOrEqual(g.y + g.height - 1); // title under the gallery
      expect(g.width).toBeGreaterThan(300);
    } else {
      expect(t.x).toBeGreaterThanOrEqual(g.x + g.width - 1); // title right of the gallery
      expect(Math.abs(g.width - t.width)).toBeLessThan(80); // two halves
    }
    // Share is disabled until hydration and the session lookup finish, then fades to its enabled colours: measure contrast after that.
    await expect(page.getByRole('button', { name: 'Share' }).first()).toBeEnabled();
    await expectNoSeriousViolations(page);
  });

  test('product: focus order', async ({ page }) => {
    const id = await productId();
    await page.goto(`/products/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: SEED.product })).toBeVisible();
    const seen: string[] = [];
    for (let step = 0; step < 45; step++) {
      await page.keyboard.press('Tab');
      seen.push(await page.evaluate(() => `${document.activeElement?.getAttribute('role') ?? ''}|${(document.activeElement?.textContent ?? '').trim().slice(0, 40)}`));
    }
    const at = (pattern: RegExp) => seen.findIndex((entry) => pattern.test(entry));
    expect(seen[0]).toMatch(/Skip to main content/i);
    const breadcrumb = at(/\|Home$/);
    const add = at(/Add to Cart/i);
    const chat = at(/Chat with seller/);
    const tab = at(/^tab\|Details/);
    expect(breadcrumb).toBeGreaterThan(0);
    expect(add).toBeGreaterThan(breadcrumb);
    expect(chat).toBeGreaterThan(add);
    expect(tab).toBeGreaterThan(chat);
  });

  test('product: not found', async ({ page }) => {
    await page.goto('/products/3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b');
    await expect(page.getByText("We couldn't find that product.")).toBeVisible();
    await expect(page.getByRole('banner')).toBeVisible(); // navbar stays
    await expect(page.getByRole('contentinfo')).toBeVisible(); // footer stays
    await expectNoSeriousViolations(page);
    await expect(page.getByRole('main')).toHaveScreenshot('product-not-found.png');
  });

  test('product: all optional sections missing', async ({ page }) => {
    const { id } = await createIsolatedProduct(); // its own category: no trending, recommendation or related rail can exist for it
    await page.goto(`/products/${id}`);
    await expect(page.getByTestId('product-price')).toBeVisible();
    await expect(page.getByTestId('gallery-placeholder')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(0); // no rail headings, no empty sections
    await expect(page.getByRole('button', { name: /add to cart/i }).first()).toBeEnabled();
    // Share is disabled until hydration and the session lookup finish, then fades to its enabled colours: measure contrast after that.
    await expect(page.getByRole('button', { name: 'Share' }).first()).toBeEnabled();
    await expectNoSeriousViolations(page);
    await expect(page.getByTestId('gallery-placeholder')).toHaveScreenshot('gallery-placeholder.png');
  });

  test('product: mobile bottom bar', async ({ page }) => {
    const id = await productId();
    await page.goto(`/products/${id}`);
    await expect(page.getByTestId('purchase-area')).toBeVisible();
    const bar = page.getByTestId('mobile-purchase-bar');
    await expect(bar).toHaveCount(0); // the main area is in view
    // The seeded product has little content: give the tab panel height so the purchase area can scroll out of view.
    await addPageStyle(page, '[role="tabpanel"] { min-height: 1800px; }');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    if (mobile(page)) {
      await expect(page.getByTestId('purchase-area')).not.toBeInViewport();
      await expect(bar).toBeVisible();
      await expect(bar).toContainText('€899.99');
      const barBox = (await bar.boundingBox())!;
      expect(barBox.y + barBox.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    } else {
      await expect(bar).toBeHidden();
    }
  });

  test('product: the mobile bottom bar fits the viewport width', async ({ page }) => {
    const id = await productId();
    await page.goto(`/products/${id}`);
    await expect(page.getByTestId('purchase-area')).toBeVisible();
    await addPageStyle(page, '[role="tabpanel"] { min-height: 1800px; }');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const bar = page.getByTestId('mobile-purchase-bar');
    if (!mobile(page)) {
      await expect(bar).toBeHidden(); // the bar is a phone-width control
      return;
    }
    await expect(bar).toBeVisible();
    await expectMainFitsWidth(page);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 700 });
      const right = (await bar.boundingBox())!;
      expect(right.x + right.width).toBeLessThanOrEqual(width + 0.5);
      const button = (await bar.getByRole('button', { name: /add to cart/i }).boundingBox())!;
      expect(button.x + button.width).toBeLessThanOrEqual(width + 0.5);
    }
  });

  test('product: no horizontal scroll at 320 px', async ({ page }) => {
    const id = await productId();
    await page.goto(`/products/${id}?tab=ask`);
    await expect(page.getByRole('heading', { level: 1, name: SEED.product })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 700 });
    await expectMainFitsWidth(page);
  });
});
