import { z } from "zod";

/**
 * Events on the realtime hub topic `chat:<channelId>` (live only, `replay: false`). `message`, `message_deleted` and
 * `channel_archived` are hints: a client syncs, it never builds state from them (W05 B-2).
 */
export const chatHubEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    data: z.object({
      channelId: z.string(),
      messageId: z.string(),
      seq: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal("message_deleted"),
    data: z.object({ channelId: z.string(), messageId: z.string() }),
  }),
  z.object({
    type: z.literal("channel_archived"),
    data: z.object({ channelId: z.string() }),
  }),
  z.object({
    type: z.literal("read"),
    data: z.object({ userId: z.string(), seq: z.number().int().nonnegative() }),
  }),
  z.object({
    type: z.literal("presence"),
    data: z.object({
      userId: z.string(),
      online: z.boolean(),
      ttlSeconds: z.number().optional(),
    }),
  }),
]);
export type ChatHubEvent = z.infer<typeof chatHubEventSchema>;
