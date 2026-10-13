import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { hamming, isNearUniform } from '../domain/duplicate-match';
import { dHash } from '../infra/image-pipeline';

/**
 * Generated inputs for the S29 suites (never a fixture file): good photos with hidden metadata, disguised files, the
 * rejection classes of AS-16, re-saved copies for duplicate detection. Real libvips, no mocks.
 */

/** Small deterministic generator so a seed always draws the same picture. */
function prng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export interface PhotoOptions {
  width?: number;
  height?: number;
  /** Different seeds give unrelated pictures (perceptual hashes far apart). */
  seed?: number;
  format?: 'jpeg' | 'png' | 'webp' | 'avif';
  /** Writes GPS, camera make and (if given) an orientation tag. */
  withMetadata?: boolean;
  orientation?: number;
  quality?: number;
}

/** Blocks of strongly different grey levels: stable under resizing and recompression. */
export async function photo(options: PhotoOptions = {}): Promise<Buffer> {
  const { width = 1800, height = 1200, seed = 1, format = 'jpeg' } = options;
  const random = prng(seed);
  const cells = 9;
  const rects: string[] = [];
  for (let row = 0; row < cells; row++)
    for (let col = 0; col < cells; col++) {
      const level = Math.floor(random() * 256);
      rects.push(
        `<rect x="${(col * width) / cells}" y="${(row * height) / cells}" width="${width / cells + 1}" height="${height / cells + 1}" fill="rgb(${level},${(level * 7) % 256},${(level * 13) % 256})"/>`,
      );
    }
  let image = sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects.join('')}</svg>`,
    ),
  );
  if (options.withMetadata || options.orientation)
    image = image.withExif({
      IFD0: { Make: 'PhoneCo', Model: 'Secret-9' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '50/1 27/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '30/1 31/1 0/1',
      },
    });
  if (options.orientation)
    image = image.withMetadata({ orientation: options.orientation });
  switch (format) {
    case 'png':
      return image.png().toBuffer();
    case 'webp':
      return image.webp({ quality: options.quality ?? 90 }).toBuffer();
    case 'avif':
      return image.avif({ quality: options.quality ?? 50 }).toBuffer();
    default:
      return image.jpeg({ quality: options.quality ?? 90 }).toBuffer();
  }
}

/** A recompressed, resized copy of a photo (the re-save a thief makes). */
export const resaved = (
  input: Buffer,
  options: { width?: number; quality?: number } = {},
): Promise<Buffer> =>
  sharp(input)
    .resize({ width: options.width ?? 900 })
    .jpeg({ quality: options.quality ?? 55 })
    .toBuffer();

/**
 * A fresh photo and its re-saved copy whose perceptual hashes are well inside the match distance (the generator is
 * random and a rare picture drifts to 4 bits, which would make a duplicate test flaky, not wrong). Every call returns
 * a picture no earlier call returned, so content-addressed objects from older runs never hide a missing write.
 */
export async function duplicatePair(
  options: {
    width?: number;
    height?: number;
    copyWidth?: number;
    quality?: number;
  } = {},
): Promise<{ original: Buffer; copy: Buffer }> {
  const {
    width = 1600,
    height = 1200,
    copyWidth = 900,
    quality = 55,
  } = options;
  for (;;) {
    const seed = Math.floor(Math.random() * 2 ** 31) + 1;
    const original = await photo({ width, height, seed });
    const copy = await resaved(original, { width: copyWidth, quality });
    const [a, b] = await Promise.all([dHash(original), dHash(copy)]);
    if (hamming(a, b) <= 2 && !isNearUniform(a)) return { original, copy };
  }
}

/** A flat grey picture: its perceptual hash is near-uniform. */
export const blankPhoto = (width = 800, height = 600): Promise<Buffer> =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 120, b: 120 },
    },
  })
    .jpeg()
    .toBuffer();

/** A saturated patch tagged Display-P3: after conversion its pixels must differ from the raw ones. */
export const displayP3Patch = (): Promise<Buffer> =>
  sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 0, g: 220, b: 40 },
    },
  })
    .withIccProfile('p3')
    .png()
    .toBuffer();

export const P3_PATCH_RAW = { r: 0, g: 220, b: 40 };

/** A 1200×1800 JPEG (displayed 1800×1200) with EXIF/GPS, orientation 6, a Display-P3 ICC profile, XMP and IPTC. */
export async function heavyMetadataJpeg(): Promise<Buffer> {
  const jpeg = await sharp({
    create: { width: 1200, height: 1800, channels: 3, background: '#c84' },
  })
    .withExif({
      IFD0: { Make: 'PhoneCo' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 27/1 0/1' },
    })
    .withMetadata({ orientation: 6 })
    .withIccProfile('p3')
    .withXmp(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><secret>owner</secret></x:xmpmeta>',
    )
    .jpeg({ quality: 90 })
    .toBuffer();
  // IPTC has no writer in sharp: add the APP13 "Photoshop 3.0" segment by hand (caption = "owner").
  const iptc = Buffer.concat([
    Buffer.from('Photoshop 3.0\0', 'ascii'),
    Buffer.from('8BIM', 'ascii'),
    Buffer.from([4, 4, 0, 0, 0, 0, 0, 10]),
    Buffer.from([0x1c, 2, 0x50, 0, 5]),
    Buffer.from('owner'),
  ]);
  const segment = Buffer.concat([
    Buffer.from([0xff, 0xed, (iptc.length + 2) >> 8, (iptc.length + 2) & 255]),
    iptc,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

export async function animatedWebp(): Promise<Buffer> {
  const frame = (r: number, g: number, b: number) =>
    sharp({
      create: { width: 64, height: 48, channels: 3, background: { r, g, b } },
    })
      .png()
      .toBuffer();
  return sharp([await frame(255, 0, 0), await frame(0, 0, 255)], {
    join: { animated: true },
  })
    .webp()
    .toBuffer();
}

export const gifImage = (): Promise<Buffer> =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: '#f00' } })
    .gif()
    .toBuffer();
export const tiffImage = (): Promise<Buffer> =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: '#f00' } })
    .tiff()
    .toBuffer();
export const svgWithScript = (): Buffer =>
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><script>alert(document.cookie)</script><rect width="64" height="48" fill="red"/></svg>',
  );
export const pdfBytes = (): Buffer =>
  Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');
export const phpScript = (): Buffer =>
  Buffer.from('<?php system($_GET["c"]); ?>');
export const textBytes = (): Buffer =>
  Buffer.from('just some text, not a picture\n');
export const zeroBytes = (): Buffer => Buffer.alloc(0);
export async function truncatedJpeg(): Promise<Buffer> {
  const whole = await photo({ width: 400, height: 300 });
  return whole.subarray(0, Math.floor(whole.length / 2));
}

const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** A PNG whose header declares `width × height` pixels while the file stays a few hundred bytes (a bomb). */
export function declaredSizePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(64))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Header says 100 megapixels (10 000 × 10 000), file is tiny. */
export const hundredMegapixelPng = (): Buffer =>
  declaredSizePng(10_000, 10_000);

export const manyBytes = (size: number): Buffer => Buffer.alloc(size, 0x41);
