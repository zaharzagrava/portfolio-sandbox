import { z } from 'zod';

/** Problem `code`s of the onboarding routes (S04 FR-100); each carries a fixed message, never user data. */
export const ONBOARDING_PROBLEM_CODES = [
  'validation_failed',
  'invalid_token',
  'permission_denied',
  'insufficient_role',
  'conflict_of_interest',
  'shop_suspended',
  'shop_not_found',
  'document_not_found',
  'review_task_not_found',
  'already_submitted',
  'submission_required',
  'resubmission_required',
  'already_verified',
  'document_already_approved',
  'document_limit_reached',
  'upload_not_received',
  'task_already_resolved',
  'document_superseded',
  'shop_offboarding',
  'document_not_required',
  'upload_mismatch',
  'iban_invalid',
  'vat_invalid',
  'missing_fields',
  'rate_limited',
] as const;
export type OnboardingProblemCode = (typeof ONBOARDING_PROBLEM_CODES)[number];

/**
 * `application/problem+json` of the onboarding routes (contracts/http.md): the platform members plus
 * `errors: [{path, message}]` on validation failures. Internal members must not be exposed.
 */
export const onboardingProblemSchema = z
  .looseObject({
    type: z.string().min(1),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    detail: z.string(),
    instance: z.string(),
    requestId: z.string().min(1),
    traceId: z.string().optional(),
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    errors: z
      .array(z.strictObject({ path: z.string(), message: z.string() }))
      .optional(),
  })
  .refine((p) => !('area' in p) && !('data' in p) && !('causes' in p), {
    message: 'internal members area/data/causes must not be exposed',
  });
export type OnboardingProblem = z.infer<typeof onboardingProblemSchema>;
