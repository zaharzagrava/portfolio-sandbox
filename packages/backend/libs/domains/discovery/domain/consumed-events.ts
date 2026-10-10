import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * Contracts of events this domain consumes but whose owners have not published them yet (research R-04/R-06). Owned
 * locally until S29 (media) and S36 (marketing) export them from their entry points; then these imports are replaced.
 * The guard value of each is the payload version below, never the envelope's `aggregateVersion` of another source.
 */
const id = z.string().uuid();

export const mediaGalleryChangedSchema = z.object({
  productId: id,
  shopId: id,
  mediaIds: z.array(id).max(100),
  galleryVersion: z.number().int().nonnegative(),
});
export type MediaGalleryChanged = z.infer<typeof mediaGalleryChangedSchema>;

export const productSponsorshipChangedSchema = z.object({
  productId: id,
  shopId: id,
  sponsored: z.boolean(),
  sponsorshipVersion: z.number().int().nonnegative(),
});
export type ProductSponsorshipChanged = z.infer<
  typeof productSponsorshipChangedSchema
>;

/** `media.events`, key = productId. */
export const MediaGalleryChanged = defineEvent(
  'media.gallery_changed',
  'media',
  1,
  mediaGalleryChangedSchema,
  { carries: 'state' },
);

/** `marketing.events`, key = productId. */
export const ProductSponsorshipChanged = defineEvent(
  'marketing.product_sponsorship_changed',
  'marketing',
  1,
  productSponsorshipChangedSchema,
  { carries: 'state' },
);
