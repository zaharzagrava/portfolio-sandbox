import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { createHash } from 'node:crypto';

export const ALLOWED_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'heif'] as const;
/** Decompression-bomb guard: a 200 KB PNG can declare 100k × 100k pixels. */
export const MAX_INPUT_PIXELS = 50_000_000;
export const VARIANTS = { thumb: 200, feed: 640, full: 1600 } as const;
export type VariantName = keyof typeof VARIANTS;

export class RejectedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RejectedImageError';
  }
}

export interface ProcessedImage {
  width: number;
  height: number;
  dhash: string;
  variants: Record<VariantName, { buffer: Buffer; hash: string; width: number; height: number; contentType: string }>;
}

/**
 * Untrusted upload → safe derivatives (10/05 #10):
 *  - the declared Content-Type is ignored; the real format comes from the bytes
 *    (sharp/libvips sniffing) and must be in the allowlist;
 *  - pixel-count limit before decoding the whole image;
 *  - EXIF orientation applied, then ALL metadata dropped (GPS coordinates in
 *    a review photo can dox the buyer's home) - sharp strips by default;
 *  - 3 widths as WebP, never upscaled; each output is content-hashed so its
 *    key is immutable (CDN `max-age=1y, immutable`, no invalidations ever).
 * Deterministic: same input → same outputs → same keys (safe to re-run).
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (error) {
    throw new RejectedImageError(`not a decodable image: ${(error as Error).message}`);
  }
  if (!meta.format || !(ALLOWED_FORMATS as readonly string[]).includes(meta.format)) throw new RejectedImageError(`format ${meta.format ?? 'unknown'} not allowed`);
  if (!meta.width || !meta.height) throw new RejectedImageError('missing dimensions');
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new RejectedImageError('image too large');

  const base = () => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).rotate(); // auto-orient from EXIF, then metadata is not re-emitted
  const variants = {} as ProcessedImage['variants'];
  for (const [name, width] of Object.entries(VARIANTS) as [VariantName, number][]) {
    const { data, info } = await base().resize({ width, withoutEnlargement: true }).webp({ quality: 80, effort: 4 }).toBuffer({ resolveWithObject: true });
    variants[name] = { buffer: data, hash: createHash('sha256').update(data).digest('hex').slice(0, 32), width: info.width, height: info.height, contentType: 'image/webp' };
  }
  const oriented = await base().toBuffer({ resolveWithObject: true });
  return { width: oriented.info.width, height: oriented.info.height, dhash: await dHash(input), variants };
}

/**
 * Difference hash: 9×8 greyscale, 1 bit per "left pixel brighter than right"
 * → 64 bits, robust to resizing/re-encoding, so a competitor's re-saved copy
 * of a product photo lands within a few bits.
 */
export async function dHash(input: Buffer): Promise<string> {
  const pixels = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) bits = (bits << 1n) | (pixels[row * 9 + col] > pixels[row * 9 + col + 1] ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** 4 × 16-bit bands of the 64-bit hash (index keys for near-duplicate candidates). */
export function bands(hash: string): [number, number, number, number] {
  return [0, 1, 2, 3].map((i) => parseInt(hash.slice(i * 4, i * 4 + 4), 16)) as [number, number, number, number];
}
