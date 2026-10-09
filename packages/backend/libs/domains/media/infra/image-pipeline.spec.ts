import sharp from 'sharp';
import {
  bands,
  dHash,
  hamming,
  processImage,
  RejectedImageError,
} from './image-pipeline';

/** The pipeline runs in the media Lambda and in the local runner; real libvips, no mocks. */
describe('image pipeline', () => {
  const photo = async (width = 2400, height = 1600) =>
    sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 200, g: 80, b: 40 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="${width}" height="${height}"><circle cx="${width / 3}" cy="${height / 2}" r="${height / 4}" fill="white"/></svg>`,
          ),
        },
      ])
      .jpeg()
      .withExif({
        IFD0: { Make: 'PhoneCo' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 27/1 0/1' },
      })
      .toBuffer();

  it('produces 3 WebP variants, never upscaled, with all metadata stripped', async () => {
    const input = await photo();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await processImage(input);
    expect(
      Object.fromEntries(
        Object.entries(out.variants).map(([k, v]) => [k, v.width]),
      ),
    ).toEqual({ thumb: 200, feed: 640, full: 1600 });
    for (const v of Object.values(out.variants)) {
      const meta = await sharp(v.buffer).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
    }
    const small = await processImage(await photo(300, 200));
    expect(small.variants.full.width).toBe(300); // withoutEnlargement
  });

  it('is deterministic: same input → same content-hashed keys', async () => {
    const input = await photo(800, 600);
    const [a, b] = await Promise.all([
      processImage(input),
      processImage(input),
    ]);
    expect(a.variants.feed.hash).toBe(b.variants.feed.hash);
  });

  it('rejects non-images and decompression bombs regardless of declared type', async () => {
    await expect(
      processImage(Buffer.from('%PDF-1.7 not an image')),
    ).rejects.toBeInstanceOf(RejectedImageError);
    const bomb = await sharp({
      create: {
        width: 10_000,
        height: 10_000,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(processImage(bomb)).rejects.toBeInstanceOf(RejectedImageError);
  });

  it('dHash: a re-encoded, resized copy is near; a different image is far; bands share a value when near', async () => {
    const original = await photo(1200, 800);
    const copy = await sharp(original)
      .resize(600)
      .jpeg({ quality: 60 })
      .toBuffer();
    const other = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: { r: 10, g: 10, b: 10 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="1200" height="800"><rect x="700" y="100" width="400" height="600" fill="white"/></svg>',
          ),
        },
      ])
      .jpeg()
      .toBuffer();
    const [h1, h2, h3] = await Promise.all([
      dHash(original),
      dHash(copy),
      dHash(other),
    ]);
    expect(hamming(h1, h2)).toBeLessThanOrEqual(3);
    expect(hamming(h1, h3)).toBeGreaterThan(10);
    expect(bands(h1).some((b, i) => b === bands(h2)[i])).toBe(true);
  });
});
