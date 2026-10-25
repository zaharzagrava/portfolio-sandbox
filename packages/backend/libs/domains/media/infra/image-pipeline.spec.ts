import sharp from 'sharp';
import { bands, hamming } from '../domain/duplicate-match';
import { RejectedImageError } from '../domain/reject-code';
import {
  animatedPng,
  animatedWebp,
  blankPhoto,
  displayP3Patch,
  gifImage,
  heavyMetadataJpeg,
  hundredMegapixelPng,
  P3_PATCH_RAW,
  pdfBytes,
  phpScript,
  photo,
  resaved,
  svgWithScript,
  textBytes,
  tiffImage,
  truncatedJpeg,
  zeroBytes,
} from '../testing/test-images';
import { dHash, processImage } from './image-pipeline';

/** The pipeline runs in the media Lambda and in the local runner; real libvips, no mocks. */
describe('image pipeline', () => {
  const widths = (out: Awaited<ReturnType<typeof processImage>>) =>
    Object.fromEntries(
      Object.entries(out.variants).map(([name, v]) => [name, v.width]),
    );

  it('S29 AS-12: produces 3 WebP variants (200/640/1600), never upscaled, aspect ratio kept', async () => {
    const out = await processImage(await photo({ width: 2400, height: 1600 }));
    expect(widths(out)).toEqual({ thumb: 200, feed: 640, full: 1600 });
    expect(out.variants.feed.height).toBeGreaterThanOrEqual(426);
    expect(out.variants.feed.height).toBeLessThanOrEqual(427);
    for (const v of Object.values(out.variants)) {
      const meta = await sharp(v.buffer).metadata();
      expect(meta.format).toBe('webp');
      expect(v.contentType).toBe('image/webp');
    }
  });

  it.each([
    ['EXIF', (m: sharp.Metadata) => m.exif],
    ['XMP', (m: sharp.Metadata) => m.xmp],
    ['IPTC', (m: sharp.Metadata) => m.iptc],
    ['ICC profile', (m: sharp.Metadata) => m.icc],
  ])(
    'S29 AS-13: no %s survives in any variant, and the image is upright',
    async (_kind, pick) => {
      const input = await heavyMetadataJpeg();
      const source = await sharp(input).metadata();
      expect(source.exif).toBeDefined();
      expect(source.xmp).toBeDefined();
      expect(source.iptc).toBeDefined();
      expect(source.icc).toBeDefined();
      expect(source.orientation).toBe(6);
      const out = await processImage(input);
      // stored 1200x1800 with orientation 6 -> displayed 1800x1200
      expect([out.width, out.height]).toEqual([1800, 1200]);
      for (const v of Object.values(out.variants)) {
        const meta = await sharp(v.buffer).metadata();
        expect(pick(meta)).toBeUndefined();
        expect(v.width).toBeGreaterThan(v.height);
      }
    },
  );

  it('S29 AS-13: pixels are converted to sRGB (a Display-P3 patch changes value)', async () => {
    const out = await processImage(await displayP3Patch());
    const { data } = await sharp(out.variants.feed.buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const [r, g, b] = [data[0], data[1], data[2]];
    expect(
      Math.abs(r - P3_PATCH_RAW.r) +
        Math.abs(g - P3_PATCH_RAW.g) +
        Math.abs(b - P3_PATCH_RAW.b),
    ).toBeGreaterThan(40); // converted, not copied
    expect(r).toBeGreaterThan(60);
    expect(r).toBeLessThan(140); // ~(100, 217, 75) after conversion, within tolerance
    expect(g).toBeGreaterThan(190);
    expect(b).toBeGreaterThan(40);
    expect(b).toBeLessThan(110);
  });

  it('S29 AS-14: a 300x200 source is never upscaled', async () => {
    const out = await processImage(await photo({ width: 300, height: 200 }));
    expect(widths(out)).toEqual({ thumb: 200, feed: 300, full: 300 });
  });

  it('S29 AS-15: same input, same bytes, same keys (also concurrently)', async () => {
    const input = await photo({ width: 800, height: 600 });
    const [a, b, c] = await Promise.all([
      processImage(input),
      processImage(input),
      processImage(input),
    ]);
    for (const name of ['thumb', 'feed', 'full'] as const) {
      expect(a.variants[name].hash).toBe(b.variants[name].hash);
      expect(a.variants[name].hash).toBe(c.variants[name].hash);
      expect(a.variants[name].buffer.equals(b.variants[name].buffer)).toBe(
        true,
      );
    }
  });

  const rejections: Array<[string, () => Promise<Buffer> | Buffer, string]> = [
    ['a PDF', pdfBytes, 'not_an_image'],
    ['a PHP script', phpScript, 'not_an_image'],
    ['a text file', textBytes, 'not_an_image'],
    ['a zero-byte file', zeroBytes, 'not_an_image'],
    ['a truncated JPEG', truncatedJpeg, 'not_an_image'],
    ['an SVG with a script', svgWithScript, 'format_not_allowed'],
    ['a GIF', gifImage, 'format_not_allowed'],
    ['a TIFF', tiffImage, 'format_not_allowed'],
    ['an animated WebP', animatedWebp, 'multi_frame'],
    ['an animated PNG', animatedPng, 'multi_frame'],
    ['a 100-megapixel PNG header', hundredMegapixelPng, 'image_too_large'],
  ];
  it.each(rejections)(
    'S29 AS-16: %s is refused as %s',
    async (_name, build, code) => {
      const error = await processImage(await build()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RejectedImageError);
      expect((error as RejectedImageError).code).toBe(code);
      // a decoder message never becomes the visible text of the refusal
      expect((error as Error).message).not.toMatch(/vips|buffer|unsupported/i);
    },
  );

  it('S29 AS-16: the bomb is decided from the header, before any pixel is decoded', async () => {
    const started = Date.now();
    await expect(processImage(hundredMegapixelPng())).rejects.toMatchObject({
      code: 'image_too_large',
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('S29 AS-17: a genuine PNG is accepted whatever it was declared as', async () => {
    const out = await processImage(
      await photo({ format: 'png', width: 600, height: 400 }),
    );
    expect(out.width).toBe(600);
  });

  it.each(['webp', 'avif'] as const)(
    'S29 AS-11: %s input is accepted',
    async (format) => {
      const out = await processImage(
        await photo({ format, width: 640, height: 480 }),
      );
      expect(out.variants.full.width).toBe(640);
    },
  );

  it('S29 FR-030: the hash is computed only when asked (product photos)', async () => {
    const input = await photo({ width: 800, height: 600 });
    expect((await processImage(input)).dhash).toBeNull();
    expect((await processImage(input, { computeHash: true })).dhash).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });

  it('S29 AS-25: dHash of a re-encoded, resized copy is near; an unrelated image is far; bands are shared', async () => {
    const original = await photo({ width: 1200, height: 800, seed: 7 });
    const copy = await resaved(original, { width: 600, quality: 55 });
    const other = await photo({ width: 1200, height: 800, seed: 99 });
    const [h1, h2, h3] = await Promise.all([
      dHash(original),
      dHash(copy),
      dHash(other),
    ]);
    expect(hamming(h1, h2)).toBeLessThanOrEqual(3);
    expect(hamming(h1, h3)).toBeGreaterThan(10);
    expect(bands(h1).some((b, i) => b === bands(h2)[i])).toBe(true);
  });

  it('S29 AS-27: a blank picture hashes to a near-uniform value', async () => {
    const hash = await dHash(await blankPhoto());
    expect(BigInt(`0x${hash}`)).toBe(0n);
  });
});
