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

export const acceptedSchema = z.object({ status: z.literal('accepted') });

export const sessionListItemSchema = z.object({
  sessionId: z.string(),
  device: z.string().nullable().optional(),
  ip: z.string().nullable().optional(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable().optional(),
  current: z.boolean(),
});

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
