import { z } from 'zod';

/** S36 `GET /ads/sponsored?category&limit` (specs/domains/S36-sponsored-listings/spec.md): at most 3 items, one per shop. */
export const sponsoredSlotSchema = z.object({
  campaignId: z.string(),
  productId: z.string(),
  shopId: z.string(),
  title: z.string(),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  sponsored: z.literal(true),
  clickUrl: z.string().min(1),
  expiresAt: z.string(),
});
export type SponsoredSlot = z.infer<typeof sponsoredSlotSchema>;

export const sponsoredSlotsResponseSchema = z.object({
  items: z.array(sponsoredSlotSchema).max(3),
  generatedAt: z.string(),
});
export type SponsoredSlotsResponse = z.infer<
  typeof sponsoredSlotsResponseSchema
>;
