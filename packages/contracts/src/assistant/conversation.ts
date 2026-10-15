import { z } from 'zod';

/**
 * S46 conversations (specs/domains/S46-shopping-assistant/contracts/http-api.md): request bodies, list query and the
 * shapes the controllers return and the web client parses. Message ids and cursors are opaque strings.
 */
export const ASSISTANT_TITLE_LIMITS = { min: 1, max: 120 } as const;
export const ASSISTANT_DEFAULT_TITLE = 'New chat';
export const ASSISTANT_CONVERSATION_LIST_LIMIT = {
  min: 1,
  max: 50,
  default: 20,
} as const;
const CURSOR_MAX = 512;

/** Conversation ids are time-based UUIDs (versions 1, 6 and 7); anything else is a `400 validation_failed` on `id`. */
export const assistantConversationIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[167][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'id must be a time-based UUID',
  );

/** `POST /assistant/conversations`: the title is trimmed, 1 to 120 characters, and defaults to "New chat". */
export const assistantCreateConversationRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(ASSISTANT_TITLE_LIMITS.min)
      .max(ASSISTANT_TITLE_LIMITS.max)
      .default(ASSISTANT_DEFAULT_TITLE),
  })
  .strict();
export type AssistantCreateConversationRequest = z.infer<
  typeof assistantCreateConversationRequestSchema
>;

export const assistantConversationSchema = z
  .object({
    id: assistantConversationIdSchema,
    title: z.string(),
    updatedAt: z.string(),
    messageCount: z.number().int().nonnegative(),
  })
  .strict();
export type AssistantConversation = z.infer<typeof assistantConversationSchema>;

export const assistantConversationListSchema = z
  .object({
    items: z.array(assistantConversationSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type AssistantConversationList = z.infer<
  typeof assistantConversationListSchema
>;

/** `GET /assistant/conversations?limit&cursor`: `limit` 1 to 50 (default 20); a bad cursor is `400 invalid_cursor`. */
export const assistantConversationListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(ASSISTANT_CONVERSATION_LIST_LIMIT.min)
      .max(ASSISTANT_CONVERSATION_LIST_LIMIT.max)
      .default(ASSISTANT_CONVERSATION_LIST_LIMIT.default),
    cursor: z.string().max(CURSOR_MAX).optional(),
  })
  .strict();
export type AssistantConversationListQuery = z.infer<
  typeof assistantConversationListQuerySchema
>;
