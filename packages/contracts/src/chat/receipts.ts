import { z } from "zod";

/** `GET /api/chat/channels/:channelId/receipts` (W05 B-3): where the other active members have read up to. */
export const chatReceiptsSchema = z.object({
  items: z.array(
    z.object({
      userId: z.string().min(1),
      lastReadSeq: z.number().int().nonnegative(),
    }),
  ),
  /** True in a channel above the huge-channel threshold: no per-person receipts are shown. */
  suppressed: z.boolean(),
});
export type ChatReceipts = z.infer<typeof chatReceiptsSchema>;
