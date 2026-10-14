import { z } from "zod";

export const CHAT_UNREAD_DEFAULT_LIMIT = 50;
export const CHAT_UNREAD_MAX_LIMIT = 200;

/** `GET /api/chat/unread` (S24; the BFF re-exports it under the same name). */
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

export const unreadQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CHAT_UNREAD_MAX_LIMIT)
    .default(CHAT_UNREAD_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

export const chatMarkReadRequestSchema = z.strictObject({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const chatMarkReadResponseSchema = z.object({
  lastReadSeq: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
});
