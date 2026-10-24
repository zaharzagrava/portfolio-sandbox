import { expect, test } from '@playwright/test';
import { register, seedProduct, shopPath } from './helpers';
import { openShopByApi } from './seller-setup';

/**
 * W04 F6 journey "video" (S30 AS-61, the seller half): the owner picks a video file on the product's video page, the upload
 * runs with one part interrupted and sent again, and the page moves to "Processing". Playing the video on the product page
 * and the unlisted link for an anonymous visitor are W02's journey (`product-video.spec.ts`, `test.fixme` until a READY
 * video can be seeded); they need an encoder in the dev stack.
 */
const PART_BYTES = 8 * 1024 * 1024;

test.describe('Seller video', () => {
  test('owner uploads a video; a failed part is sent again; the page shows it processing', async ({ page }) => {
    const member = await register(page);
    const { shopId } = await openShopByApi(member);
    const productId = await seedProduct(shopId, { title: 'Video Test Mug' }, member);

    // The first PUT of the first part fails once; the page sends that part again (and only that part).
    let failed = false;
    const sent: string[] = [];
    await page.route((url) => url.origin !== 'http://localhost:3000' && !url.pathname.startsWith('/api/'), async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      sent.push(route.request().url());
      if (!failed) {
        failed = true;
        return route.abort('connectionreset');
      }
      return route.fallback();
    });

    await page.goto(shopPath(shopId, `products/${productId}/media/video`));
    await expect(page.getByRole('heading', { level: 1, name: 'Video' })).toBeVisible();
    await page.getByLabel('Video file').setInputFiles({ name: 'tour.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(PART_BYTES + 4096, 1) });
    await page.getByLabel('Title').fill('Kiln tour');
    await page.getByRole('button', { name: 'Upload video' }).click();

    await expect(page.getByText(/^Processing|^Ready$/).first()).toBeVisible({ timeout: 60_000 });
    expect(failed).toBe(true);
    // Every part was sent at least once and the failed one twice.
    expect(sent.length).toBeGreaterThan(new Set(sent).size);
    await expect(page.getByRole('table', { name: 'Videos of this product' })).toContainText('Kiln tour');
  });
});
