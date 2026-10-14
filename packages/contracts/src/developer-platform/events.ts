import { z } from 'zod';

/** S42 event payloads (contracts/events.md). No event carries a key, a secret or a hash. */
const keyEventBase = {
  keyId: z.string(),
  shopId: z.string(),
  prefix: z.string(),
  livemode: z.boolean(),
  scopes: z.array(z.string()),
};

export const apiKeyCreatedPayloadSchema = z.object({
  ...keyEventBase,
  actorId: z.string(),
});
export const apiKeyRotatedPayloadSchema = z.object({
  ...keyEventBase,
  actorId: z.string(),
  successorId: z.string(),
});
export const API_KEY_REVOKE_REASONS = [
  'manual',
  'shop_deleted',
  'rotation_expired',
] as const;
export const apiKeyRevokedPayloadSchema = z.object({
  ...keyEventBase,
  actorId: z.string().optional(),
  reason: z.enum(API_KEY_REVOKE_REASONS),
});
export const apiVersionPinnedPayloadSchema = z.object({
  shopId: z.string(),
  version: z.string(),
  previousVersion: z.string().nullable(),
  actorId: z.string().nullable(),
});

/** `api.request_logged` v1 with the additive S42 fields. */
export const apiRequestLoggedPayloadSchema = z.object({
  requestId: z.string(),
  clientRequestId: z.string().optional(),
  shopId: z.string(),
  keyId: z.string(),
  livemode: z.boolean(),
  version: z.string(),
  method: z.string(),
  route: z.string(),
  status: z.number().int(),
  durationMs: z.number().int(),
  deprecated: z.boolean(),
  errorCode: z.string().optional(),
  batchOps: z.number().int().optional(),
  idempotentReplay: z.boolean().default(false),
  cost: z.number().int().min(1).default(1),
});
export type ApiRequestLoggedPayload = z.infer<
  typeof apiRequestLoggedPayloadSchema
>;

export const usageRecordedPayloadSchema = z.object({
  metric: z.literal('api.calls'),
  quantity: z.number().int().min(1),
  ts: z.string(),
});

/** Consumed from `tenancy.events`. */
export const tenancyShopDeletedSchema = z.object({
  shopId: z.string(),
  shopVersion: z.number().int().optional(),
});
export const tenancyShopStatusChangedSchema = z.object({
  shopId: z.string(),
  from: z.string(),
  to: z.string(),
  reason: z.string().optional(),
  shopVersion: z.number().int(),
});
