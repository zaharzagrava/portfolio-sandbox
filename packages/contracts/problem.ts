import { z } from 'zod';

/**
 * RFC 9457 problem document returned by every backend error response (S54 FR-001).
 * Members `area`, `data` and `causes` are internal and must never appear on the wire.
 */
export const problemDetailsSchema = z
  .looseObject({
    type: z.string().min(1),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    detail: z.string(),
    instance: z.string(),
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    requestId: z.string().min(1),
    traceId: z.string().optional(),
    errors: z.array(z.object({ field: z.string(), code: z.string() })).optional(),
  })
  .refine((p) => !('area' in p) && !('data' in p) && !('causes' in p), {
    message: 'internal members area/data/causes must not be exposed',
  });

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
