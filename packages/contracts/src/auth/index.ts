import { z } from 'zod';

/** Credential response shared by login and refresh (S01 contracts/auth-http.md). */
export const authSessionSchema = z.object({
  accessToken: z.object({ token: z.string().min(1), expiresIn: z.number() }),
  refreshToken: z.string().min(1),
  sessionId: z.string().min(1),
  user: z.object({
    id: z.string(),
    email: z.string().nullable(),
    role: z.enum(['USER', 'SELLER', 'MODERATOR', 'ADMIN']),
  }),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export const mfaChallengeSchema = z.object({
  mfaRequired: z.literal(true),
  mfaToken: z.string().min(1),
});

/** `GET /auth/mfa`: the state of the caller's second factor; never a secret or a digest (S02 contracts/http.md). */
export const mfaStatusSchema = z
  .object({
    state: z.enum(['none', 'pending', 'enabled']),
    enabledAt: z.string().optional(),
    recoveryCodesRemaining: z.number().int().min(0).optional(),
  })
  .strict();

export const mfaEnrollSchema = z
  .object({
    otpauthUri: z.string().startsWith('otpauth://totp/'),
    manualEntryKey: z.string().min(1),
  })
  .strict();

export const mfaRecoveryCodesSchema = z
  .object({
    recoveryCodes: z
      .array(z.string().regex(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/))
      .length(10),
  })
  .strict();

export const oidcProviderSchema = z
  .object({ id: z.string().min(1), displayName: z.string().min(1) })
  .strict();

export const oidcStartSchema = z
  .object({ authorizationUrl: z.string().url() })
  .strict();

export const federatedIdentitySchema = z
  .object({
    id: z.string().uuid(),
    provider: z.string().min(1),
    email: z.string().nullable(),
    linkedAt: z.string(),
  })
  .strict();

export const acceptedSchema =z.object({ status: z.literal('accepted') });

/** `GET /auth/sessions` item (S01 FR-037); also the shape the web renders. */
export const sessionListItemSchema = z
  .object({
    sessionId: z.string().min(1),
    device: z.string().nullable(),
    ip: z.string().nullable(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    current: z.boolean(),
  })
  .strict();
export type SessionListItem = z.infer<typeof sessionListItemSchema>;

/** `POST /auth/register` (S01 FR-001). Unknown members (such as a role) are refused. */
export const registerRequestSchema = z
  .object({ email: z.string(), password: z.string() })
  .strict();
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/** `POST /auth/password-reset/request` (S01 FR-080). */
export const passwordResetRequestSchema = z.object({ email: z.string() });
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

/** `POST /auth/password-reset/confirm` (S01 FR-081). */
export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(1),
});
export type PasswordResetConfirm = z.infer<typeof passwordResetConfirmSchema>;

/** Body of confirm, regenerate and disable (S02): one code of 1..64 characters (a TOTP or a recovery code). */
export const mfaCodeRequestSchema = z
  .object({ code: z.string().min(1).max(64) })
  .strict();
export type MfaCodeRequest = z.infer<typeof mfaCodeRequestSchema>;

export const jwksSchema = z.object({
  keys: z.array(
    z.object({
      kty: z.literal('EC'),
      crv: z.literal('P-256'),
      alg: z.literal('ES256'),
      use: z.literal('sig'),
      kid: z.string(),
      x: z.string(),
      y: z.string(),
    }),
  ),
});

export const passwordResetSchema = {
  request: z.object({ email: z.string() }),
  confirm: z.object({ token: z.string().min(1), password: z.string().min(1) }),
};

export const jobDtoSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  runAt: z.string().nullable(),
  attempts: z.number(),
  maxAttempts: z.number(),
  shopId: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export const scheduleDtoSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
});
export const jobsAdminSchemas = {
  job: jobDtoSchema,
  schedule: scheduleDtoSchema,
  list: z.object({
    items: z.array(jobDtoSchema),
    nextCursor: z.string().optional(),
  }),
};
