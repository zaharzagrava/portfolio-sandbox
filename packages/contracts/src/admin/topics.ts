import { z } from 'zod';

/** J03 event tap (`GET /api/admin/topics/:topic/messages`): read-only view of relayed events, local profile only. */
export const TOPIC_TAP_LIMITS = { max: 200, default: 50 } as const;

export const topicMessageSchema = z.object({
  eventId: z.string().min(1),
  type: z.string().min(1),
  key: z.string(),
  version: z.number().int().min(0),
  occurredAt: z.iso.datetime(),
  payload: z.unknown(),
});

export const topicMessagePageSchema = z.object({
  items: z.array(topicMessageSchema),
});

export const topicMessagesQuerySchema = z.object({
  type: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(TOPIC_TAP_LIMITS.max).default(TOPIC_TAP_LIMITS.default),
});

export type TopicMessage = z.infer<typeof topicMessageSchema>;
export type TopicMessagePage = z.infer<typeof topicMessagePageSchema>;
