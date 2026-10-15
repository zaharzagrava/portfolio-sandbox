import { z } from 'zod';
import { productEventSchemas } from '../catalog/index.ts';
import { orderEventSchemas } from '../orders/order-events.ts';

/**
 * S43 webhook delivery to shops (specs/domains/S43-webhooks/contracts/{http,events,outbound}.md): dashboard request and
 * response schemas, the event catalogue, the problem codes, the consumed source events and the receiver-side
 * signature rules. Unknown properties are refused on every request.
 */
const instant = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------- catalogue and limits

export const WEBHOOK_EVENT_TYPES = [
  'order.paid',
  'order.cancelled',
  'order.refunded',
  'product.created',
  'product.updated',
  'product.archived',
  'product.deleted',
  'product.stock_low',
  'payout.paid',
  'payout.failed',
  'webhook.ping',
] as const;
export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventTypeName = z.infer<typeof webhookEventTypeSchema>;

export const WEBHOOK_RESOURCES = ['order', 'product', 'payout', 'ping'] as const;

export const WEBHOOK_LIMITS = {
  urlMax: 2048,
  events: { min: 1, max: 20 },
  endpointsPerShop: 20,
  overlapHours: { min: 1, max: 72, default: 24 },
  page: { min: 1, max: 100, default: 25 },
  idempotencyTtlHours: 24,
  pingsPerMinute: 10,
  logRetentionDays: 30,
  historyRetentionDays: 400,
} as const;

export const webhookEventTypeInfoSchema = z.object({
  type: webhookEventTypeSchema,
  description: z.string(),
  resource: z.enum(WEBHOOK_RESOURCES),
  since: z.string(),
});
export type WebhookEventTypeInfo = z.infer<typeof webhookEventTypeInfoSchema>;
export const webhookEventTypesResponseSchema = z.object({
  items: z.array(webhookEventTypeInfoSchema),
});

// ---------------------------------------------------------------- endpoint requests

/** A date version (`2026-01-15`) or `latest`; whether the registry supports it is the server's decision (`isSupported`). */
export const webhookApiVersionSchema = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2}|latest)$/, 'apiVersion must be a date or "latest"');

const eventsSchema = z
  .array(webhookEventTypeSchema)
  .min(WEBHOOK_LIMITS.events.min)
  .max(WEBHOOK_LIMITS.events.max)
  .refine((e) => new Set(e).size === e.length, {
    message: 'events must be distinct',
  });

const urlSchema = z.string().min(1).max(WEBHOOK_LIMITS.urlMax);

export const createWebhookEndpointRequestSchema = z
  .object({
    url: urlSchema,
    events: eventsSchema,
    apiVersion: webhookApiVersionSchema.optional(),
  })
  .strict();
export type CreateWebhookEndpointRequest = z.infer<
  typeof createWebhookEndpointRequestSchema
>;

export const updateWebhookEndpointRequestSchema = z
  .object({
    url: urlSchema.optional(),
    events: eventsSchema.optional(),
    apiVersion: webhookApiVersionSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one of url, events, apiVersion is required',
  });
export type UpdateWebhookEndpointRequest = z.infer<
  typeof updateWebhookEndpointRequestSchema
>;

export const rotateWebhookSecretRequestSchema = z
  .object({
    overlapHours: z
      .number()
      .int()
      .min(WEBHOOK_LIMITS.overlapHours.min)
      .max(WEBHOOK_LIMITS.overlapHours.max)
      .optional(),
  })
  .strict();
export type RotateWebhookSecretRequest = z.infer<
  typeof rotateWebhookSecretRequestSchema
>;

const pageLimit = z.coerce
  .number()
  .int()
  .min(WEBHOOK_LIMITS.page.min)
  .max(WEBHOOK_LIMITS.page.max)
  .default(WEBHOOK_LIMITS.page.default);

export const webhookEndpointListQuerySchema = z
  .object({ limit: pageLimit, cursor: z.string().max(512).optional() })
  .strict();

export const webhookAttemptsQuerySchema = z
  .object({
    eventId: z.string().max(128).optional(),
    ok: z.enum(['true', 'false']).optional(),
    limit: pageLimit,
    cursor: z.string().max(512).optional(),
  })
  .strict();

// ---------------------------------------------------------------- endpoint responses

/** `whsec_` plus 43 base64url characters (256 bits); shown once at create and rotate. */
export const WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9_-]{43}$/;

export const WEBHOOK_ENDPOINT_STATUSES = ['enabled', 'disabled'] as const;
export const WEBHOOK_DISABLED_REASONS = ['manual', 'auto_failing'] as const;

/** The only secret-related fields of a read: `hasPreviousSecret` and `previousSecretExpiresAt` (never a secret). */
export const webhookEndpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(webhookEventTypeSchema),
  apiVersion: z.string(),
  status: z.enum(WEBHOOK_ENDPOINT_STATUSES),
  disabledReason: z.enum(WEBHOOK_DISABLED_REASONS).nullable(),
  failingSince: instant.nullable(),
  breaker: z.enum(['closed', 'open']),
  hasPreviousSecret: z.boolean(),
  previousSecretExpiresAt: instant.nullable(),
  createdAt: instant,
  updatedAt: instant,
});
export type WebhookEndpointDto = z.infer<typeof webhookEndpointSchema>;

export const createdWebhookEndpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(webhookEventTypeSchema),
  apiVersion: z.string(),
  status: z.literal('enabled'),
  secret: z.string().regex(WEBHOOK_SECRET_PATTERN),
  createdAt: instant,
});
export type CreatedWebhookEndpoint = z.infer<
  typeof createdWebhookEndpointSchema
>;

export const rotatedWebhookSecretSchema = z.object({
  secret: z.string().regex(WEBHOOK_SECRET_PATTERN),
  previousSecretExpiresAt: instant,
});

export const webhookEndpointPageSchema = z.object({
  items: z.array(webhookEndpointSchema),
  nextCursor: z.string().nullable(),
});

export const WEBHOOK_DELIVERY_STATES = [
  'queued',
  'delivering',
  'delivered',
  'retry_scheduled',
  'exhausted',
  'cancelled',
  'failed',
] as const;
export const webhookDeliveryStateSchema = z.enum(WEBHOOK_DELIVERY_STATES);
export type WebhookDeliveryStateName = z.infer<
  typeof webhookDeliveryStateSchema
>;

export const webhookAttemptSchema = z.object({
  attemptId: z.string(),
  deliveryId: z.string(),
  eventId: z.string(),
  type: webhookEventTypeSchema,
  attempt: z.number().int().positive(),
  startedAt: instant,
  durationMs: z.number().int().nonnegative(),
  status: z.number().int().nullable(),
  ok: z.boolean(),
  error: z.string().optional(),
  responseSnippet: z.string().optional(),
  replay: z.boolean(),
});
export type WebhookAttemptDto = z.infer<typeof webhookAttemptSchema>;
export const webhookAttemptPageSchema = z.object({
  items: z.array(webhookAttemptSchema),
  nextCursor: z.string().nullable(),
});

export const webhookEventDetailSchema = z.object({
  eventId: z.string(),
  type: webhookEventTypeSchema,
  createdAt: instant,
  state: webhookDeliveryStateSchema,
  attempts: z.number().int().nonnegative(),
  body: z.record(z.string(), z.unknown()),
});

export const webhookDeliveryAcceptedSchema = z.object({
  deliveryId: z.string(),
  eventId: z.string(),
  endpointId: z.string(),
  state: z.literal('queued'),
});

// ---------------------------------------------------------------- problem codes (FR-050)

export const WEBHOOK_ERROR_CODES = [
  'validation_failed',
  'invalid_cursor',
  'permission_denied',
  'webhook_endpoint_not_found',
  'webhook_event_not_found',
  'duplicate_endpoint_url',
  'endpoint_state_conflict',
  'rotation_in_progress',
  'no_previous_secret',
  'endpoint_disabled',
  'idempotency_in_flight',
  'endpoint_url_rejected',
  'endpoint_limit_reached',
  'idempotency_key_required',
  'idempotency_key_reuse',
  'rate_limited',
  'service_unavailable',
] as const;
export const webhookErrorCodeSchema = z.enum(WEBHOOK_ERROR_CODES);
export type WebhookErrorCode = z.infer<typeof webhookErrorCodeSchema>;

/**
 * Problem document of every error answer of the webhook routes (RFC 9457, `application/problem+json`). `code` is one of
 * `WEBHOOK_ERROR_CODES` for the routes' own failures; the platform adds its codes for authentication (`invalid_token`),
 * so the schema only requires a string (`webhookErrorCodeSchema` tells the route's own codes apart). `details` holds `reason` of a rejected
 * address and `status` of a state conflict; `errors` lists the fields of a `400 validation_failed`.
 */
export const webhookProblemSchema = z.looseObject({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  instance: z.string(),
  requestId: z.string().min(1),
  code: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  errors: z
    .array(z.object({ field: z.string(), code: z.string() }))
    .optional(),
});
export type WebhookProblem = z.infer<typeof webhookProblemSchema>;

/** Closed list of `details.reason` of `422 endpoint_url_rejected`. */
export const ENDPOINT_URL_REJECTION_REASONS = [
  'not_https',
  'credentials_not_allowed',
  'port_not_allowed',
  'ip_literal',
  'blocked_address',
  'unresolvable',
] as const;
export const endpointUrlRejectionReasonSchema = z.enum(
  ENDPOINT_URL_REJECTION_REASONS,
);
export type EndpointUrlRejectionReason = z.infer<
  typeof endpointUrlRejectionReasonSchema
>;

/** Closed list of attempt `error` values (S54 failure vocabulary plus the delivery-only ones). */
export const WEBHOOK_ATTEMPT_ERRORS = [
  'blocked_address',
  'unresolvable',
  'invalid_url',
  'redirect_refused',
  'redirected_host',
  'too_many_redirects',
  'unsupported_content_type',
  'timeout',
  'tls_error',
  'network_error',
  'payload_too_large',
] as const;

// ---------------------------------------------------------------- outbound message (contracts/outbound.md)

export const WEBHOOK_EVENT_ID_PATTERN = /^evt_[0-9a-f]{32}$/;

/** The JSON a receiver gets; `resource_version` is null for pings. `data.object` is a fat snapshot of the shop's own data. */
export const webhookMessageSchema = z.object({
  id: z.string().regex(WEBHOOK_EVENT_ID_PATTERN),
  object: z.literal('event'),
  type: webhookEventTypeSchema,
  created: instant,
  api_version: z.string(),
  resource_version: z.number().int().nonnegative().nullable(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
export type WebhookMessage = z.infer<typeof webhookMessageSchema>;

export const WEBHOOK_HEADERS = {
  signature: 'Marketplace-Signature',
  eventId: 'Marketplace-Event-Id',
  deliveryId: 'Marketplace-Delivery-Id',
  eventType: 'Marketplace-Event-Type',
  attempt: 'Marketplace-Attempt',
  replay: 'Marketplace-Replay',
} as const;

// ---------------------------------------------------------------- consumed source events

const id = z.string().min(1);
const minor = z.number().int().nonnegative();
const shopIds = z.array(id).min(1);

/**
 * `order.cancelled` and `order.refunded` carry `shopIds` once S10 ships the field; until then it may be absent and the
 * router falls back to the orders service behind a flag (plan.md Complexity Tracking).
 */
export const webhookOrderEventSchemas = {
  'order.paid': orderEventSchemas['order.paid'],
  'order.cancelled': orderEventSchemas['order.cancelled'].extend({
    shopIds: shopIds.optional(),
  }),
  'order.refunded': orderEventSchemas['order.refunded'].extend({
    shopIds: shopIds.optional(),
  }),
} as const;

export type WebhookOrderPaidEvent = z.infer<
  (typeof webhookOrderEventSchemas)['order.paid']
>;
export type WebhookOrderStatusEvent = z.infer<
  (typeof webhookOrderEventSchemas)['order.cancelled']
>;
export type WebhookOrderRefundedEvent = z.infer<
  (typeof webhookOrderEventSchemas)['order.refunded']
>;

export const webhookProductEventSchemas = productEventSchemas;

/** Payout events (S15); the repo has no shared schema yet, so S43 declares what it needs and tolerates additions. */
export const webhookPayoutEventSchemas = {
  'payout.paid': z.looseObject({
    payoutId: id,
    shopId: id,
    periodStart: z.string(),
    amountMinor: minor,
    currency: z.string(),
    transferRef: z.string().optional(),
    paidAt: z.string().optional(),
    payoutVersion: z.number().int().positive(),
    isSandbox: z.boolean().optional(),
  }),
  'payout.failed': z.looseObject({
    payoutId: id,
    shopId: id,
    periodStart: z.string(),
    amountMinor: minor,
    currency: z.string(),
    failureCode: z.string().optional(),
    payoutVersion: z.number().int().positive(),
    isSandbox: z.boolean().optional(),
  }),
} as const;

export type WebhookPayoutPaidEvent = z.infer<
  (typeof webhookPayoutEventSchemas)['payout.paid']
>;
export type WebhookPayoutFailedEvent = z.infer<
  (typeof webhookPayoutEventSchemas)['payout.failed']
>;

export const webhookShopDeletedSchema = z.looseObject({ shopId: id });

// ---------------------------------------------------------------- receiver-side signature rules (FR-016, AS-17)

export const WEBHOOK_SIGNATURE_HEADER = 'Marketplace-Signature';
export const WEBHOOK_SIGNATURE_TOLERANCE_SEC = 300;

export interface ParsedSignatureHeader {
  t: number;
  v1: string[];
}

/**
 * Strict parser of `t=<unix>,v1=<hex>[,v1=<hex>]`. Returns null for anything else: absent or empty header, a pair
 * without `=`, a duplicate `t`, a non-integer `t`, no `v1`, a `v1` that is not an even-length lowercase or uppercase
 * hex string. Never throws.
 */
export function parseSignatureHeader(
  header: string | null | undefined,
): ParsedSignatureHeader | null {
  if (typeof header !== 'string' || header.length === 0) return null;
  let t: number | undefined;
  const v1: string[] = [];
  for (const pair of header.split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) return null;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (key === 't') {
      if (t !== undefined || !/^\d{1,15}$/.test(value)) return null;
      t = Number(value);
    } else if (key === 'v1') {
      if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) return null;
      v1.push(value.toLowerCase());
    }
    // unknown keys are ignored: a later scheme may add `v2` without breaking this verifier
  }
  if (t === undefined || v1.length === 0) return null;
  return { t, v1 };
}

/**
 * Reference verifier (the rules of AS-17) with the HMAC injected so this package stays free of Node built-ins
 * (it is also imported by the web app). `hmacHex(secret, "<t>.<body>")` must return the lower-case hex HMAC-SHA256.
 * Accepts when any `v1` matches in constant time and `|now - t| <= tolerance`. Never throws.
 */
export function verifySignatureWith(
  hmacHex: (secret: string, message: string) => string,
  equalHex: (a: string, b: string) => boolean,
  input: {
    body: string;
    header: string | null | undefined;
    secret: string;
    nowMs: number;
    toleranceSec?: number;
  },
): boolean {
  try {
    const parsed = parseSignatureHeader(input.header);
    if (!parsed) return false;
    const tolerance = input.toleranceSec ?? WEBHOOK_SIGNATURE_TOLERANCE_SEC;
    if (Math.abs(input.nowMs / 1000 - parsed.t) > tolerance) return false;
    const expected = hmacHex(input.secret, `${parsed.t}.${input.body}`);
    let ok = false;
    for (const candidate of parsed.v1) if (equalHex(candidate, expected)) ok = true;
    return ok;
  } catch {
    return false;
  }
}
