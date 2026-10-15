import { z } from 'zod';

/** `POST /assistant/conversations/:id/messages` (S46 AS-03): text 1 to 4000 characters after trimming. */
export const ASSISTANT_TEXT_LIMITS = { min: 1, max: 4000 } as const;

/** The required header `Idempotency-Key`; a missing key is `422 idempotency_key_required`, a malformed one `400`. */
export const ASSISTANT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const assistantIdempotencyKeySchema = z
  .string()
  .regex(ASSISTANT_IDEMPOTENCY_KEY_PATTERN);

const codePoints = (s: string) => [...s].length;

/**
 * The device location (`lat`, `lng`) comes only from here, both or neither; it is never stored, logged or sent to the
 * model (S46 AS-13). Unknown fields (`model`, `system`, `tools`) are refused.
 */
export const assistantSendMessageRequestSchema = z
  .object({
    text: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => codePoints(s) >= ASSISTANT_TEXT_LIMITS.min, {
        message: 'text must not be empty',
      })
      .refine((s) => codePoints(s) <= ASSISTANT_TEXT_LIMITS.max, {
        message: `text must be at most ${ASSISTANT_TEXT_LIMITS.max} characters`,
      }),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.lat !== undefined && v.lng === undefined) {
      ctx.addIssue({ code: 'custom', path: ['lng'], message: 'lng is required with lat' });
    }
    if (v.lng !== undefined && v.lat === undefined) {
      ctx.addIssue({ code: 'custom', path: ['lat'], message: 'lat is required with lng' });
    }
  });
export type AssistantSendMessageRequest = z.infer<
  typeof assistantSendMessageRequestSchema
>;
