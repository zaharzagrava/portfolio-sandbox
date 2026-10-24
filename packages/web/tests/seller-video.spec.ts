import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * A REAL 2-second clip (made with ffmpeg) followed by one MP4 "free" padding box, so the file is a bit more than one part long
 * and still plays. A file of filler bytes is not a video: the worker rejects it ("That file isn't a video.") within a moment,
 * and the page can show that before it ever shows "Processing".
 */
function realVideoOfAtLeast(bytes: number): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'seller-video-'));
  try {
    const file = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', file]);
    const clip = readFileSync(file);
    const padSize = Math.max(8, bytes - clip.length);
    const free = Buffer.alloc(padSize, 0);
    free.writeUInt32BE(padSize, 0);
    free.write('free', 4, 'latin1');
    return Buffer.concat([clip, free]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
    await page.getByLabel('Video file').setInputFiles({ name: 'tour.mp4', mimeType: 'video/mp4', buffer: realVideoOfAtLeast(PART_BYTES + 4096) });
    await page.getByLabel('Title').fill('Kiln tour');
    await page.getByRole('button', { name: 'Upload video' }).click();

    await expect(page.getByText(/^Processing|^Ready$/).first()).toBeVisible({ timeout: 60_000 });
    expect(failed).toBe(true);
    // Every part was sent at least once and the failed one twice.
    expect(sent.length).toBeGreaterThan(new Set(sent).size);
    await expect(page.getByRole('table', { name: 'Videos of this product' })).toContainText('Kiln tour');
  });
});
