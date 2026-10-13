import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * Contracts of events this domain consumes but whose owners have not published them yet (research R-04/R-06). Owned
 * locally until S36 (marketing) exports its own; then that import is replaced. `media.gallery_changed` is now exported
 * by S29 (media), which registers the one definition of `media.gallery_changed@1` a process may hold: S32 re-exports it
 * here instead of defining it a second time (a second `defineEvent` of the same pair fails at import).
 * The guard value of each is the payload version below, never the envelope's `aggregateVersion` of another source.
 */
const id = z.string().uuid();

export { MediaGalleryChanged } from '@app/domains/media';

export const productSponsorshipChangedSchema = z.object({
  productId: id,
  shopId: id,
  sponsored: z.boolean(),
  sponsorshipVersion: z.number().int().nonnegative(),
});
export type ProductSponsorshipChanged = z.infer<
  typeof productSponsorshipChangedSchema
>;

/** `marketing.events`, key = productId. */
export const ProductSponsorshipChanged = defineEvent(
  'marketing.product_sponsorship_changed',
  'marketing',
  1,
  productSponsorshipChangedSchema,
  { carries: 'state' },
);
