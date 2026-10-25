import { expect, test } from '@playwright/test';
import { createIsolatedProduct } from './helpers';

/**
 * JV (W02 AS-65, AS-72; S30 AS-31, AS-38): a product with one READY public video shows a "Videos" group on the Details tab;
 * activating the tile loads the player and plays the video, and one `video_view` event is queued.
 *
 * `test.fixme` until the dev stack can seed a READY public video for a product (S30 upload + transcode finish only with a
 * running encoder; gaps G8/H6) and the product page aggregate carries its `videos` section. The unit tests
 * (`components/product/video-section.test.tsx`) cover the behaviour against the contract meanwhile.
 */
test.describe('Product video @desktop', () => {
  test.fixme('play a product video', async ({ page }) => {
    // Needs: a READY public video attached to the product (S30 seed), `VIDEO_HOST` in the CSP `media-src`/`connect-src`.
    const product = await createIsolatedProduct();
    const events: unknown[] = [];
    await page.route('**/api/events', async (route) => {
      events.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, contentType: 'application/json', body: '{"accepted":1,"rejected":[]}' });
    });

    await page.goto(`/products/${product.id}`);
    const group = page.getByRole('region', { name: 'Videos' });
    await expect(group).toBeVisible();
    const hlsRequests: string[] = [];
    page.on('request', (request) => {
      if (/hls/i.test(request.url())) hlsRequests.push(request.url());
    });
    expect(hlsRequests).toEqual([]);

    await group.getByRole('button').first().click();
    const video = group.locator('video');
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('controls', '');
    await expect(async () => {
      expect(await video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });

    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect.poll(() => JSON.stringify(events)).toContain('video_view');
  });
});
