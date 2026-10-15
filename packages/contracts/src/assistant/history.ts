import { z } from 'zod';
import { assistantConversationIdSchema } from './conversation.ts';

/**
 * `GET /assistant/conversations/:id/messages`: only visible text and tool names. Thinking, raw tool input, raw tool
 * output and the per-turn context block never appear (S46 AS-08).
 */
export const assistantHistoryMessageSchema = z
  .object({
    id: z.string().min(1),
    turnId: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    tools: z.array(z.string()),
  })
  .strict();
export type AssistantHistoryMessage = z.infer<
  typeof assistantHistoryMessageSchema
>;

export const assistantHistorySchema = z
  .object({
    conversation: z
      .object({
        id: assistantConversationIdSchema,
        title: z.string(),
        updatedAt: z.string(),
      })
      .strict(),
    messages: z.array(assistantHistoryMessageSchema),
  })
  .strict();
export type AssistantHistory = z.infer<typeof assistantHistorySchema>;
