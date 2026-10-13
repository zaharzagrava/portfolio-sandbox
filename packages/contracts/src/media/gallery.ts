import { z } from 'zod';

/** One READY image of a product (W02 B-1). `urls` are the three processed variants; width/height are the original's. */
export const productGalleryItemSchema = z
  .object({
    mediaId: z.uuid(),
    position: z.number().int().min(0),
    urls: z
      .object({
        thumb: z.string().min(1),
        feed: z.string().min(1),
        full: z.string().min(1),
      })
      .strict(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  })
  .strict();
export type ProductGalleryItem = z.infer<typeof productGalleryItemSchema>;

/** `GET /api/products/:productId/gallery`, ordered by `position`. */
export const productGallerySchema = z
  .object({ items: z.array(productGalleryItemSchema) })
  .strict();
export type ProductGallery = z.infer<typeof productGallerySchema>;

/** S29 names for the same public read (`galleryPublicSchema` of the spec's Provides list). */
export const galleryPublicSchema = productGallerySchema;
export type GalleryPublic = ProductGallery;

export const GALLERY_MAX_PHOTOS = 20;

/** `PUT /api/shops/:shopId/products/:productId/gallery`: the whole list replaces the gallery (FR-040). */
export const galleryPutRequestSchema = z
  .object({
    mediaIds: z
      .array(z.uuid())
      .max(GALLERY_MAX_PHOTOS)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'mediaIds must be unique',
      }),
    expectedVersion: z.number().int().min(0),
  })
  .strict();
export type GalleryPutRequest = z.infer<typeof galleryPutRequestSchema>;

/** Member read and write answer: the ordered items and the gallery version (0 when none). */
export const galleryMemberSchema = z
  .object({
    items: z.array(productGalleryItemSchema),
    version: z.number().int().min(0),
  })
  .strict();
export type GalleryMember = z.infer<typeof galleryMemberSchema>;

export const galleryFailureCodeSchema = z.enum(['not_found', 'not_ready']);
