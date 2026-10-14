import { z } from "zod";

export const CHAT_BODY_MAX = 4000;
export const CHAT_HISTORY_DEFAULT_LIMIT = 50;
export const CHAT_HISTORY_MAX_LIMIT = 100;

/** Trimmed, 1–4,000 code points (not UTF-16 units). */
export const chatBodySchema = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0 && [...s].length <= CHAT_BODY_MAX, {
    message: "body must be 1-4000 characters",
  });

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  authorId: z.string().uuid(),
  body: z.string().nullable(),
  replyToId: z.string().uuid().nullable(),
  createdAt: z.string().min(1),
  deleted: z.boolean(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const sendMessageRequestSchema = z.strictObject({
  clientMessageId: z.string().uuid(),
  body: chatBodySchema,
  replyToId: z.string().uuid().optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const sendMessageResponseSchema = z.object({
  message: chatMessageSchema,
  duplicate: z.boolean(),
});
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

export const chatMessagePageSchema = z.object({
  items: z.array(chatMessageSchema),
  nextCursor: z.string().nullable(),
});
export type ChatMessagePage = z.infer<typeof chatMessagePageSchema>;

export const historyQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CHAT_HISTORY_MAX_LIMIT)
    .default(CHAT_HISTORY_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});
