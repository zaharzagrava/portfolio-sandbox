import { expect, test } from '@playwright/test';
import { openShop, register, seedProduct, shopPath } from './helpers';

/**
 * W04 F6 journey "photos" (S29): the owner of a fresh shop opens the photos of a product from the inventory menu, adds a
 * photo (signed upload, complete, wait for READY), saves the gallery with its version and sees it again after a reload.
 * The edge cases (rejected file, version conflict, 20-photo limit) are unit tests in `components/seller/media/gallery-view.test.tsx`.
 *
 * Needs the media worker of the dev stack to turn the upload into READY; without it the photo stays "Processing" and the
 * test fails at that step (see `specs/UNVERIFIED.md`, S29 rows).
 */
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.describe('Seller photos', () => {
  test('owner adds a photo to a product and saves the gallery', async ({ page }) => {
    const member = await register(page);
    const { shopId } = await openShop(page);
    const title = 'Photo Test Mug';
    await seedProduct(shopId, { title }, member);

    // From the inventory row menu to the photos page.
    await page.goto(shopPath(shopId, 'inventory'));
    await page.getByRole('button', { name: `Actions for ${title}` }).click();
    await page.getByRole('menuitem', { name: 'Photos and video' }).click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}\/media$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible();
    await expect(page.getByText('No photos yet.')).toBeVisible();

    await page.getByLabel('Add photos').setInputFiles({ name: 'mug.png', mimeType: 'image/png', buffer: PIXEL_PNG });
    const list = page.getByRole('list', { name: 'Photos' });
    await expect(list.getByRole('img')).toHaveCount(1, { timeout: 60_000 });
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByText('Photos saved')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('list', { name: 'Photos' }).getByRole('img')).toHaveCount(1);
    await expect(page.getByText('1 of 20 photos')).toBeVisible();
  });
});
