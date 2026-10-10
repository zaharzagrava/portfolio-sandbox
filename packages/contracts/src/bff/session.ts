import { z } from 'zod';

export const BFF_SESSION_LIMITS = { bodyBytes: 16 * 1024 } as const;

export const sessionLoginRequestSchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(1).max(1024),
  })
  .strict();
export type SessionLoginRequest = z.infer<typeof sessionLoginRequestSchema>;

export const sessionMfaRequestSchema = z
  .object({ code: z.string().min(1).max(64) })
  .strict();
export type SessionMfaRequest = z.infer<typeof sessionMfaRequestSchema>;

/** `GET /api/bff/session` and the success answer of login / MFA. No token, no digest. */
export const sessionResponseSchema = z
  .object({
    user: z.object({
      id: z.string(),
      email: z.string().nullable(),
      role: z.enum(['USER', 'SELLER', 'MODERATOR', 'ADMIN']),
    }),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** The challenge token stays on the server; the browser only learns that a second factor is needed. */
export const mfaRequiredResponseSchema = z
  .object({ mfaRequired: z.literal(true) })
  .strict();
export type MfaRequiredResponse = z.infer<typeof mfaRequiredResponseSchema>;

export const BFF_SESSION_PROBLEM_CODES = [
  'validation_failed',
  'ambiguous_credentials',
  'origin_not_allowed',
  'csrf_invalid',
  'mfa_not_pending',
  'unauthenticated',
  'session_expired',
  'session_unavailable',
  'invalid_token',
  'invalid_credentials',
  'rate_limited',
  'payload_too_large',
  'unsupported_media_type',
] as const;

export const BFF_COOKIES = {
  session: '__Host-bff-session',
  csrf: '__Host-bff-csrf',
  mfa: '__Host-bff-mfa',
} as const;
export const BFF_CSRF_HEADER = 'x-csrf-token';
