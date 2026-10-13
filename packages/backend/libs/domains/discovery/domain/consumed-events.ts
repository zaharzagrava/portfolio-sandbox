import type { z } from 'zod';
import { productSponsorshipChangedPayloadSchema } from '@marketplace-sandbox/contracts';

/**
 * Contracts of events this domain consumes whose owners export the definition (research R-04/R-06): a process may hold
 * one definition of each `type@version` (a second `defineEvent` fails at import), so S32 re-exports the owners' instead
 * of defining its own. `media.gallery_changed` comes from S29 (media), `marketing.product_sponsorship_changed` from S36
 * (marketing). The guard value of each is the payload version, never the envelope's `aggregateVersion` of another source.
 */
export { MediaGalleryChanged } from '@app/domains/media';

export { ProductSponsorshipChanged } from '@app/domains/marketing';
export const productSponsorshipChangedSchema =
  productSponsorshipChangedPayloadSchema;
export type ProductSponsorshipChanged = z.infer<
  typeof productSponsorshipChangedPayloadSchema
>;
