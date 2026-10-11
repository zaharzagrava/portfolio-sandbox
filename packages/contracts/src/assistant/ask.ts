import { z } from 'zod';

/** S47 `POST /products/:productId/ask` (specs/domains/S47-rag-help-center/spec.md): request body and SSE payloads. */
export const RAG_QUESTION_LIMITS = { min: 3, max: 500 } as const;

export const ragAskRequestSchema = z
  .object({
    question: z
      .string()
      .min(RAG_QUESTION_LIMITS.min)
      .max(RAG_QUESTION_LIMITS.max),
  })
  .strict();
export type RagAskRequest = z.infer<typeof ragAskRequestSchema>;

export const ragSourceSchema = z.object({
  n: z.number().int().positive(),
  chunkId: z.string(),
  documentId: z.string(),
  title: z.string(),
  headingPath: z.array(z.string()),
  page: z.number().int().nullable(),
});
export type RagSource = z.infer<typeof ragSourceSchema>;

/**
 * One parsed SSE message. Clients put the SSE `event:` name in `event` and spread the parsed `data:` JSON next to it
 * before validating.
 */
export const ragStreamEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('sources'),
    mode: z.enum(['hybrid', 'keyword']),
    items: z.array(ragSourceSchema),
  }),
  z.object({ event: z.literal('text'), t: z.string() }),
  z.object({
    event: z.literal('done'),
    citations: z.array(
      z.object({ text: z.string(), sources: z.array(z.number().int()) }),
    ),
    grounded: z.boolean(),
  }),
  z.object({ event: z.literal('not_found'), message: z.string() }),
  z.object({
    event: z.literal('refusal'),
    category: z.string(),
    source: z.enum(['provider', 'moderation']).optional(),
  }),
  z.object({
    event: z.literal('error'),
    code: z.enum(['PROVIDER_UNAVAILABLE', 'TIMEOUT', 'INTERNAL']),
  }),
]);
export type RagStreamEvent = z.infer<typeof ragStreamEventSchema>;
