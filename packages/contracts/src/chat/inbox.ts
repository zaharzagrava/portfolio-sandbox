import { z } from "zod";
import { chatChannelSchema } from "./channel.ts";

/** `GET /api/chat/channels/mine` (W05 B-1): the caller's chats with the unread count and the last activity. */
export const CHAT_INBOX_DEFAULT_LIMIT = 50;
export const CHAT_INBOX_MAX_LIMIT = 100;

export const chatInboxItemSchema = chatChannelSchema.extend({
  unread: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  lastMessageAt: z.string().min(1).nullable(),
});
export type ChatInboxItem = z.infer<typeof chatInboxItemSchema>;

export const chatInboxPageSchema = z.object({
  items: z.array(chatInboxItemSchema),
  nextCursor: z.string().nullable(),
});
export type ChatInboxPage = z.infer<typeof chatInboxPageSchema>;

export const chatInboxQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CHAT_INBOX_MAX_LIMIT)
    .default(CHAT_INBOX_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});
