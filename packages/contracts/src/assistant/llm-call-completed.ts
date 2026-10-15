import { z } from 'zod';

/**
 * Event `llm.call_completed` v1 (specs/domains/S46-shopping-assistant/contracts/llm-call-completed-v1.md): one durable
 * record per model call, consumed by billing (S18) and the analytics projector. Fields are only ever added within v1, so
 * the objects are not strict; `scopeId` and `outcome` stay optional for older producers (S47).
 */
export const LLM_CALL_COMPLETED_PURPOSES = [
  'chat',
  'summary',
  'extraction',
  'rag',
] as const;
export const LLM_CALL_COMPLETED_OUTCOMES = [
  'completed',
  'refused',
  'aborted',
  'failed',
] as const;

const count = z.number().int().nonnegative();

export const llmCallCompletedPayloadV1Schema = z.object({
  userId: z.string(),
  /** The billed subject: the user, or the shop for document extraction. */
  subjectId: z.string().min(1),
  /** `llm.assistant.tokens`, `llm.rag.tokens` or the extraction metric. */
  metric: z.string().regex(/^llm\.[a-z0-9_.]+$/),
  billableTokens: count,
  /** The scope id: a conversation, a document or a product. */
  conversationId: z.string(),
  scopeId: z.string().optional(),
  messageId: z.string(),
  /** `"<messageId>:<n>"`; the summary call is `:0`. */
  callId: z.string().min(1),
  purpose: z.enum(LLM_CALL_COMPLETED_PURPOSES),
  requestedModel: z.string(),
  model: z.string(),
  outcome: z.enum(LLM_CALL_COMPLETED_OUTCOMES).optional(),
  /** null when the call produced no text. */
  ttftMs: count.nullable(),
  durationMs: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  costMicros: count,
  usageEstimated: z.boolean(),
  stopReason: z.string(),
  toolCalls: count,
});
export type LlmCallCompletedPayloadV1 = z.infer<
  typeof llmCallCompletedPayloadV1Schema
>;

export const llmCallCompletedV1 = z.object({
  /** UUIDv5 of the `callId`, so a redelivery keeps its identity. */
  eventId: z.string().min(1),
  type: z.literal('llm.call_completed'),
  version: z.literal(1),
  occurredAt: z.string(),
  aggregateId: z.string().min(1),
  payload: llmCallCompletedPayloadV1Schema,
});
export type LlmCallCompletedV1 = z.infer<typeof llmCallCompletedV1>;
