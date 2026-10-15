import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

export const LLM_PURPOSES = ['chat', 'summary', 'extraction', 'rag'] as const;
export const LLM_OUTCOMES = [
  'completed',
  'refused',
  'aborted',
  'failed',
] as const;

const count = z.number().int().min(0);

/**
 * One per model call (aggregateId = callId): the usage record S18 charges (identity `llm:<aggregateId>`) and the row of
 * ClickHouse `llm_requests`. Fields are only ever added within v1 (`contracts/llm-call-completed-v1.md`); `scopeId` and
 * `outcome` stay optional so producers of the first S47 version still parse.
 */
export const LlmCallCompleted = defineEvent(
  'llm.call_completed',
  'llm',
  1,
  z.object({
    userId: z.string(),
    /** Billed subject: a user, or a shop for document extraction. */
    subjectId: z.string(),
    /** `llm.assistant.tokens`, `llm.rag.tokens` or an extraction metric. */
    metric: z.string(),
    billableTokens: count,
    /** The scope id: a conversation, a document or a product. */
    conversationId: z.string(),
    scopeId: z.string().optional(),
    messageId: z.string(),
    callId: z.string(),
    purpose: z.enum(LLM_PURPOSES),
    requestedModel: z.string(),
    model: z.string(),
    outcome: z.enum(LLM_OUTCOMES).optional(),
    /** null when no text was produced (pure tool round, refusal, failure). */
    ttftMs: count.nullable(),
    durationMs: count,
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    costMicros: count,
    /** True when the provider gave no counts and they are `chars / 4` estimates. */
    usageEstimated: z.boolean(),
    stopReason: z.string(),
    toolCalls: count,
  }),
);
