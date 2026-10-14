import { z } from "zod";
import { clientFlagsSchema } from "../experimentation/flags.ts";
import { postPageSchema, type PostPage } from "../community/discussions.ts";
import { pickupPointsNearResponseSchema } from "../fulfilment/pickup.ts";

/**
 * Bodies of upstream capabilities that publish no schema in this package yet (S48 gaps C2/C3). Each one names the
 * owning spec; the BFF validates with them and forwards the body unchanged, so they stay open (`looseObject`) for the
 * owner's fields and strict only about what the BFF relies on. When the owner publishes its own schema, replace the
 * entry here with a re-export.
 */

/** S38 `GET /api/flags`: the evaluated flags of the caller (S38 owns the schema; the name stays for the BFF). */
export const flagsResponseSchema = clientFlagsSchema;
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

/** S25 `GET /api/boards/:productId/posts`: S25 published its own schema, the BFF validates with it (name kept). */
export const boardPostsPageSchema = postPageSchema;
export type BoardPostsPage = PostPage;

/** S30 `GET /api/products/:productId/videos`: S30 published `productVideosSchema` in `media/video.ts` (exported from the package root). */

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
