import { z } from 'zod';

/** S42 dashboard key routes (contracts/http.md section B). Unknown properties are refused. */
export const API_KEY_SCOPES = [
  'products:read',
  'products:write',
  'orders:read',
  'stock:write',
] as const;
export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

export const API_KEY_LIMITS = {
  name: { min: 1, max: 60 },
  scopes: { min: 1, max: 4 },
  expiresInDaysMax: 365,
  overlapHours: { min: 0, max: 168, default: 24 },
  perShop: 25,
} as const;

export const API_KEY_STATUSES = [
  'active',
  'rotating',
  'expired',
  'revoked',
] as const;
export const apiKeyStatusSchema = z.enum(API_KEY_STATUSES);
export type ApiKeyStatus = z.infer<typeof apiKeyStatusSchema>;

const instant = z.iso.datetime({ offset: true });

export const createApiKeyRequestSchema = z
  .object({
    name: z
      .string()
      .transform((s) => s.trim())
      .refine(
        (s) =>
          s.length >= API_KEY_LIMITS.name.min &&
          s.length <= API_KEY_LIMITS.name.max,
        { message: 'name must be 1..60 characters' },
      ),
    scopes: z
      .array(apiKeyScopeSchema)
      .min(API_KEY_LIMITS.scopes.min)
      .max(API_KEY_LIMITS.scopes.max)
      .refine((s) => new Set(s).size === s.length, {
        message: 'scopes must be distinct',
      }),
    livemode: z.boolean(),
    expiresAt: instant.optional(),
  })
  .strict();
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

export const rotateApiKeyRequestSchema = z
  .object({
    overlapHours: z
      .number()
      .int()
      .min(API_KEY_LIMITS.overlapHours.min)
      .max(API_KEY_LIMITS.overlapHours.max)
      .optional(),
  })
  .strict();
export type RotateApiKeyRequest = z.infer<typeof rotateApiKeyRequestSchema>;

const keyBase = {
  id: z.string(),
  prefix: z.string().length(12),
  name: z.string(),
  scopes: z.array(apiKeyScopeSchema),
  livemode: z.boolean(),
  status: apiKeyStatusSchema,
  expiresAt: instant.nullable(),
  createdAt: instant,
};

/** Create/rotate answer: the secret is shown once and never again. */
export const createdApiKeySchema = z.object({
  ...keyBase,
  key: z.string().regex(/^sk_(live|test)_[0-9A-Za-z]{12}_[0-9A-Za-z]{32}$/),
  previousExpiresAt: instant.nullable().optional(),
});
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>;

export const apiKeyListItemSchema = z.object({
  ...keyBase,
  lastUsedAt: instant.nullable(),
  createdBy: z.string(),
  successorId: z.string().nullable().optional(),
});
export type ApiKeyListItem = z.infer<typeof apiKeyListItemSchema>;

export const apiKeyListSchema = z.object({
  items: z.array(apiKeyListItemSchema),
  nextCursor: z.string().nullable(),
});

export const pinVersionRequestSchema = z
  .object({ version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .strict();

export const apiVersionStateSchema = z.object({
  version: z.string(),
  pinnedAt: instant.nullable(),
  supported: z.array(
    z.object({
      version: z.string(),
      status: z.enum(['supported', 'deprecated', 'retired']),
      sunset: instant.optional(),
    }),
  ),
  latest: z.string(),
});

export const pinVersionResultSchema = z.object({
  version: z.string(),
  previousVersion: z.string().nullable(),
  pinnedAt: instant,
});
