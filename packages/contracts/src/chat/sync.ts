import { z } from "zod";
import { chatMessageSchema } from "./message.ts";

export const CHAT_SYNC_MAX_CHANNELS = 50;

const cursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** `POST /chat/sync`: more than 50 keys is refused as a whole, never truncated. */
export const chatSyncRequestSchema = z.object({
  cursors: z
    .record(z.string().uuid(), cursor)
    .refine((r) => Object.keys(r).length <= CHAT_SYNC_MAX_CHANNELS, {
      message: "too_many_channels",
    }),
});
export type ChatSyncRequest = z.infer<typeof chatSyncRequestSchema>;

export const chatChannelSyncSchema = z.object({
  channelId: z.string().uuid(),
  messages: z.array(chatMessageSchema),
  lastSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type ChatChannelSync = z.infer<typeof chatChannelSyncSchema>;
export const chatSyncResponseSchema = z.array(chatChannelSyncSchema);
