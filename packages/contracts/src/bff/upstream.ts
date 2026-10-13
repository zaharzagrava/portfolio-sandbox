import { z } from 'zod';
import { pickupPointsNearResponseSchema } from '../fulfilment/pickup.ts';

/**
 * Bodies of upstream capabilities that publish no schema in this package yet (S48 gaps C2/C3). Each one names the
 * owning spec; the BFF validates with them and forwards the body unchanged, so they stay open (`looseObject`) for the
 * owner's fields and strict only about what the BFF relies on. When the owner publishes its own schema, replace the
 * entry here with a re-export.
 */

/** S38 `GET /api/flags`: the evaluated flags of the caller. */
export const flagsResponseSchema = z.looseObject({
  flags: z.record(z.string(), z.unknown()),
});
export type FlagsResponse = z.infer<typeof flagsResponseSchema>;

/** S24 `GET /api/chat/unread`: `{items: [{channelId, unread, lastSeq}], nextCursor}`. */
export const chatUnreadPageSchema = z.object({
  items: z.array(
    z.object({
      channelId: z.string(),
      unread: z.number().int().nonnegative(),
      lastSeq: z.number().int().nonnegative(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type ChatUnreadPage = z.infer<typeof chatUnreadPageSchema>;

/** S25 `GET /api/boards/:productId/posts`: `{items: PostView[], nextCursor, degraded?}`. */
export const boardPostsPageSchema = z.looseObject({
  items: z.array(z.looseObject({ id: z.string() })),
  nextCursor: z.string().nullable(),
  degraded: z.literal(true).optional(),
});
export type BoardPostsPage = z.infer<typeof boardPostsPageSchema>;

/** S30 `GET /api/products/:productId/videos`. */
export const productVideosSchema = z.looseObject({
  items: z.array(z.looseObject({})),
});
export type ProductVideos = z.infer<typeof productVideosSchema>;

/** S19 `GET /api/pickup-points/near`: the capability's own schema (S19 published it; the name stays for the BFF). */
export const pickupPageSchema = pickupPointsNearResponseSchema;
export type PickupPage = z.infer<typeof pickupPageSchema>;

/** S11 `GET /api/flash-sales?productIds=`: at most one public view per product. */
export const flashSalePublicSchema = z.looseObject({ productId: z.string() });
export const flashSalesResponseSchema = z.array(flashSalePublicSchema);
export type FlashSalePublic = z.infer<typeof flashSalePublicSchema>;

/** S21 `GET /api/auctions?productIds=`. */
export const auctionPublicSchema = z.looseObject({ productId: z.string() });
export const auctionsResponseSchema = z.array(auctionPublicSchema);
export type AuctionPublic = z.infer<typeof auctionPublicSchema>;
