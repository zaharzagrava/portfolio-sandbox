import { z } from 'zod';

/**
 * S46 reply stream (specs/domains/S46-shopping-assistant/contracts/stream-events.md). Clients put the SSE `event:` name
 * in `event` and spread the parsed `data:` JSON next to it before validating. The `id:` field is the resume cursor
 * and is not part of the data. No other event type is ever sent; `done` carries no cost, model name or cache counter.
 */
export const ASSISTANT_STREAM_EVENT_NAMES = [
  'meta',
  'text',
  'tool',
  'done',
  'refusal',
  'error',
] as const;

export const ASSISTANT_ERROR_CODES = [
  'CANCELLED',
  'PROVIDER_UNAVAILABLE',
  'TURN_TIMEOUT',
  'GENERATION_LOST',
  'MODERATION_UNAVAILABLE',
  'SHUTTING_DOWN',
  'TOOL_LOOP_LIMIT',
  'INTERNAL',
] as const;
export type AssistantErrorCode = (typeof ASSISTANT_ERROR_CODES)[number];

const count = z.number().int().nonnegative();

export const assistantStreamEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      event: z.literal('meta'),
      messageId: z.string().min(1),
      conversationId: z.string().min(1),
    })
    .strict(),
  z.object({ event: z.literal('text'), t: z.string() }).strict(),
  z
    .object({
      event: z.literal('tool'),
      id: z.string(),
      name: z.string(),
      status: z.enum(['running', 'done', 'failed']),
    })
    .strict(),
  z
    .object({
      event: z.literal('done'),
      stopReason: z.string(),
      truncated: z.boolean(),
      usage: z.object({ inputTokens: count, outputTokens: count }).strict(),
      allowance: z.object({ used: count, limit: count }).strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('refusal'),
      category: z.string(),
      source: z.enum(['provider', 'moderation']),
    })
    .strict(),
  z
    .object({
      event: z.literal('error'),
      code: z.enum(ASSISTANT_ERROR_CODES),
      retryAfterMs: count.optional(),
    })
    .strict(),
]);
export type AssistantStreamEvent = z.infer<typeof assistantStreamEventSchema>;

/** The header `Last-Event-ID` of a resume: `<digits>-<digits>`; anything else is `400 invalid_last_event_id`. */
export const assistantLastEventIdSchema = z.string().regex(/^\d+-\d+$/);

/** `POST /assistant/messages/:messageId/cancel` → `202`. */
export const assistantCancelResponseSchema = z
  .object({ cancelling: z.literal(true) })
  .strict();
