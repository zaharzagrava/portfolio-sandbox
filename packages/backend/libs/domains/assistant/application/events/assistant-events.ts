import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** One per model call (key = userId): latency, tokens, cost, outcome → ClickHouse `llm_requests`. */
export const LlmCallCompleted = defineEvent('llm.call_completed', 'llm', 1, z.object({
  userId: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  purpose: z.enum(['chat', 'summary', 'rag', 'extraction']),
  requestedModel: z.string(),
  model: z.string(),
  /** null when no text was produced (pure tool round, refusal, failure). */
  ttftMs: z.number().int().nullable(),
  durationMs: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  costMicros: z.number().int(),
  stopReason: z.string(),
  toolCalls: z.number().int(),
}));
