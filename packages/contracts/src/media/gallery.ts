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
