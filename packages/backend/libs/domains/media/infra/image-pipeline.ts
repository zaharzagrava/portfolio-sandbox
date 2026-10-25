import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { createHash } from 'node:crypto';
import { RejectedImageError } from '../domain/reject-code';
import { MAX_INPUT_PIXELS } from '../domain/upload-policy';

export { RejectedImageError };
export const VARIANTS = { thumb: 200, feed: 640, full: 1600 } as const;
export type VariantName = keyof typeof VARIANTS;

export interface ProcessedImage {
  width: number;
  height: number;
  /** 64-bit hex perceptual hash; null unless `computeHash` (product photos only, FR-030). */
  dhash: string | null;
  variants: Record<
    VariantName,
    {
      buffer: Buffer;
      hash: string;
      width: number;
      height: number;
      contentType: string;
    }
  >;
}

/** The bytes decide, not the label (AS-17): JPEG, PNG, WebP, and AVIF (a HEIF container with an AV1 payload). */
function isAllowedFormat(meta: Metadata): boolean {
  if (meta.format === 'jpeg' || meta.format === 'png' || meta.format === 'webp')
    return true;
  return meta.format === 'heif' && meta.compression === 'av1';
}

/**
 * An animated PNG (APNG) keeps its first frame in a normal image and adds an `acTL` chunk before the first `IDAT`;
 * sharp reads one page either way, so the chunk list is walked here (chunk headers only, S29.R-09: one frame).
 */
function isAnimatedPng(input: Buffer): boolean {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (input.length < 8 || !input.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  while (offset + 8 <= input.length) {
    const type = input.toString('latin1', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + input.readUInt32BE(offset);
  }
  return false;
}

/** Header-only inspection: nothing here decodes pixels, so a decompression bomb costs nothing (AS-16). */
async function inspect(
  input: Buffer,
): Promise<{ width: number; height: number; meta: Metadata }> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw new RejectedImageError('not_an_image');
  }
  if (!meta.format) throw new RejectedImageError('not_an_image');
  if (!isAllowedFormat(meta))
    throw new RejectedImageError('format_not_allowed');
  if (!meta.width || !meta.height) throw new RejectedImageError('not_an_image');
  if (meta.width * meta.height > MAX_INPUT_PIXELS)
    throw new RejectedImageError('image_too_large');
  if ((meta.pages ?? 1) > 1 || isAnimatedPng(input))
    throw new RejectedImageError('multi_frame');
  const swap = (meta.orientation ?? 1) >= 5;
  return {
    width: swap ? meta.height : meta.width,
    height: swap ? meta.width : meta.height,
    meta,
  };
}

/**
 * Untrusted upload → safe derivatives (S29 FR-011–FR-016):
 *  - the declared Content-Type is ignored; the format comes from the bytes and must be in the allowlist;
 *  - pixel count, frame count and format are decided from the header before the pixels are decoded;
 *  - EXIF orientation is applied, the pixels are converted to sRGB through the embedded profile, then ALL metadata is
 *    dropped (GPS coordinates in a review photo can dox the buyer's home);
 *  - 3 widths as WebP, never upscaled; each output is content-hashed so its key is immutable;
 *  - deterministic: same input → same outputs → same keys (safe to re-run).
 * Every refusal is a `RejectedImageError` with a code of the closed vocabulary; the decoder message is never kept.
 */
export async function processImage(
  input: Buffer,
  options: { computeHash?: boolean } = {},
): Promise<ProcessedImage> {
  const { width, height } = await inspect(input);
  const base = () =>
    sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .pipelineColourspace('rgb16')
      .toColourspace('srgb');
  const variants = {} as ProcessedImage['variants'];
  try {
    for (const [name, target] of Object.entries(VARIANTS) as [
      VariantName,
      number,
    ][]) {
      const { data, info } = await base()
        .resize({ width: target, withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      variants[name] = {
        buffer: data,
        hash: createHash('sha256').update(data).digest('hex'),
        width: info.width,
        height: info.height,
        contentType: 'image/webp',
      };
    }
    return {
      width,
      height,
      dhash: options.computeHash ? await dHash(input) : null,
      variants,
    };
  } catch (error) {
    if (error instanceof RejectedImageError) throw error;
    // A header that passed but pixels that do not decode (truncated, corrupt): the input is bad, not the system.
    throw new RejectedImageError('not_an_image', (error as Error).message);
  }
}

/**
 * Difference hash: 9×8 greyscale of the oriented image, 1 bit per "left pixel brighter than right" → 64 bits, robust
 * to resizing/re-encoding, so a re-saved copy of a photo lands within a few bits. The matching rules are in
 * `domain/duplicate-match.ts`.
 */
export async function dHash(input: Buffer): Promise<string> {
  const pixels = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();
  let bits = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++)
      bits =
        (bits << 1n) |
        (pixels[row * 9 + col] > pixels[row * 9 + col + 1] ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}
