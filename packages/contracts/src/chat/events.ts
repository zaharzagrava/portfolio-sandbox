import { z } from "zod";

/** `chat.events` payloads of S24 (contracts/events.md). No author name, e-mail or full body. */
export const chatMessagePostedPayloadSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  seq: z.number().int(),
  authorId: z.string(),
  preview: z.string().max(120),
});
export const chatMessageEscalatedPayloadSchema = z.object({
  recipientId: z.string(),
  channelId: z.string(),
  channelTitle: z.string(),
  messageId: z.string(),
  seq: z.number().int(),
  authorId: z.string(),
  preview: z.string().max(120),
  dedupeKey: z.string(),
});

/** Body of the `chat-offline-notify` queue. */
export const chatOfflineNotifyBodySchema = z.object({
  eventId: z.string(),
  channelId: z.string(),
  messageId: z.string(),
  seq: z.number().int(),
  authorId: z.string(),
  recipientId: z.string(),
  preview: z.string(),
});
export type ChatOfflineNotifyBody = z.infer<typeof chatOfflineNotifyBodySchema>;
