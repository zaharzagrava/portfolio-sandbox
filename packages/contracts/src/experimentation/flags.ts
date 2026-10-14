import { z } from "zod";

/**
 * S38 feature flags (specs/domains/S38-feature-flags/contracts/flags-api.md). Used by the admin and client controllers,
 * the SDK's snapshot parser, the BFF and the e2e specs. A response never carries an internal column; the client schema
 * never carries rules, owners or descriptions.
 */

export const FLAG_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const FLAG_VARIANT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const FLAG_RULE_ID_PATTERN = /^[a-z0-9-]{1,32}$/;
export const FLAG_ATTRIBUTES = [
  "userId",
  "shopId",
  "role",
  "email_domain",
  "country",
  "platform",
  "plan",
] as const;
export const FLAG_OPERATORS = [
  "in",
  "not_in",
  "eq",
  "neq",
  "gte",
  "lte",
  "exists",
] as const;
export const FLAG_BUCKET_BY = ["userId", "shopId"] as const;
export const FLAG_STATUSES = [
  "enabled",
  "disabled",
  "killed",
  "archived",
] as const;
export const FLAG_ACTIONS = [
  "create",
  "update",
  "kill",
  "restore",
  "archive",
] as const;
export const FLAG_PLATFORMS = ["web", "ios", "android"] as const;

export const FLAG_LIMITS = {
  variants: 20,
  rules: 50,
  conditions: 10,
  values: 100,
  valueBytes: 4096,
  flags: 500,
  description: 500,
  owner: 100,
  bodyBytes: 256 * 1024,
  rolloutSlices: 10,
} as const;

export const FLAG_PROBLEM_CODES = [
  "validation_failed",
  "flag_not_found",
  "version_conflict",
  "flag_killed",
  "flag_archived",
  "invalid_transition",
  "flag_definition_invalid",
  "flag_limit_reached",
  "invalid_cursor",
  "payload_too_large",
] as const;
export type FlagProblemCode = (typeof FLAG_PROBLEM_CODES)[number];

/** Codes of `errors[].code` in a `flag_definition_invalid` answer. */
export const FLAG_DEFINITION_ERROR_CODES = [
  "invalid_key",
  "unknown_variant",
  "duplicate_variant_key",
  "invalid_variant_key",
  "duplicate_rule_id",
  "invalid_rule_id",
  "rule_target_invalid",
  "weights_sum_invalid",
  "weight_invalid",
  "duplicate_rollout_variant",
  "rollout_size_invalid",
  "unknown_attribute",
  "unknown_operator",
  "values_arity_invalid",
  "value_type_invalid",
  "bucket_by_invalid",
  "expires_at_invalid",
  "expires_at_in_past",
  "variants_missing",
  "too_many_variants",
  "too_many_rules",
  "too_many_conditions",
  "too_many_values",
  "value_too_large",
  "description_too_long",
  "owner_too_long",
  "owner_missing",
] as const;
export type FlagDefinitionErrorCode =
  (typeof FLAG_DEFINITION_ERROR_CODES)[number];

export const flagValueSchema = z.union([
  z.boolean(),
  z.string(),
  z.number(),
  z.record(z.string(), z.unknown()),
]);
export type FlagValue = z.infer<typeof flagValueSchema>;

const variantSchema = z.object({ key: z.string(), value: flagValueSchema });
const conditionSchema = z.object({
  attribute: z.string(),
  op: z.string(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
const rolloutSliceSchema = z.object({
  variant: z.string(),
  weight: z.number(),
});
const ruleSchema = z.object({
  id: z.string(),
  conditions: z.array(conditionSchema),
  variant: z.string().optional(),
  rollout: z.array(rolloutSliceSchema).optional(),
});

/** Request shape of `PUT /api/admin/flags/:key` (semantic checks are the domain's: 422). Unknown properties are refused. */
export const flagInputSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    description: z.string().optional(),
    owner: z.string(),
    enabled: z.boolean(),
    variants: z.array(variantSchema),
    defaultVariant: z.string(),
    offVariant: z.string(),
    rules: z.array(ruleSchema),
    bucketBy: z.string().optional(),
    clientSide: z.boolean().optional(),
    expiresAt: z.string().nullable().optional(),
  })
  .strict();
export type FlagInput = z.infer<typeof flagInputSchema>;

const strictVariant = z.object({ key: z.string(), value: flagValueSchema });
const strictRule = z.object({
  id: z.string(),
  conditions: z.array(
    z.object({
      attribute: z.enum(FLAG_ATTRIBUTES),
      op: z.enum(FLAG_OPERATORS),
      values: z.array(z.union([z.string(), z.number(), z.boolean()])),
    }),
  ),
  variant: z.string().optional(),
  rollout: z
    .array(z.object({ variant: z.string(), weight: z.number().int() }))
    .optional(),
});

export const flagSchema = z.object({
  key: z.string(),
  description: z.string(),
  owner: z.string(),
  status: z.enum(FLAG_STATUSES),
  enabled: z.boolean(),
  variants: z.array(strictVariant),
  defaultVariant: z.string(),
  offVariant: z.string(),
  rules: z.array(strictRule),
  bucketBy: z.enum(FLAG_BUCKET_BY),
  clientSide: z.boolean(),
  expiresAt: z.string().nullable(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Flag = z.infer<typeof flagSchema>;

export const flagPageSchema = z.object({
  items: z.array(flagSchema),
  nextCursor: z.string().nullable(),
});
export type FlagPage = z.infer<typeof flagPageSchema>;

export const flagAuditEntrySchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  flagKey: z.string(),
  action: z.enum(FLAG_ACTIONS),
  actorId: z.string(),
  requestId: z.string().nullable(),
  at: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()),
});
export const flagAuditPageSchema = z.object({
  items: z.array(flagAuditEntrySchema),
  nextCursor: z.string().nullable(),
});
export type FlagAuditPage = z.infer<typeof flagAuditPageSchema>;

/** `GET /api/flags`: what a browser sees; the variant is there so the client can log an exposure. */
export const clientFlagsSchema = z.object({
  version: z.number().int().min(0),
  flags: z.record(
    z.string(),
    z.object({ variant: z.string(), value: flagValueSchema }),
  ),
});
export type ClientFlags = z.infer<typeof clientFlagsSchema>;

export const staleFlagsSchema = z.object({
  days: z.number().int(),
  items: z.array(
    z.object({
      key: z.string(),
      owner: z.string(),
      status: z.enum(FLAG_STATUSES),
      expiresAt: z.string().nullable(),
      createdAt: z.string(),
      evaluations: z.number().int().min(0),
      expired: z.boolean(),
      reason: z.enum(["expired", "unused"]),
    }),
  ),
});
export type StaleFlags = z.infer<typeof staleFlagsSchema>;

const rolloutSumsTo10000 = (rules: z.infer<typeof strictRule>[]) =>
  rules.every(
    (r) =>
      !r.rollout || r.rollout.reduce((s, x) => s + x.weight, 0) === 10_000,
  );

/** The ruleset every SDK holds: every non-archived flag. A corrupt snapshot (weights not summing to 10,000) is rejected. */
export const flagRulesetSnapshotSchema = z.object({
  version: z.number().int().min(0),
  flags: z.array(
    z.object({
      key: z.string(),
      status: z.enum(["enabled", "disabled", "killed"]),
      variants: z.array(strictVariant),
      defaultVariant: z.string(),
      offVariant: z.string(),
      rules: z.array(strictRule).refine(rolloutSumsTo10000, {
        message: "rollout weights must sum to 10000",
      }),
      bucketBy: z.enum(FLAG_BUCKET_BY),
      clientSide: z.boolean(),
      version: z.number().int().min(1),
    }),
  ),
});
export type FlagRulesetSnapshot = z.infer<typeof flagRulesetSnapshotSchema>;

export const FLAG_CHANGED_EVENT_TYPE = "experimentation.flag_changed" as const;
/** Payload of `experimentation.flag_changed` v1: which flag changed and how; never the definition. */
export const flagChangedPayloadSchema = z.object({
  flagKey: z.string(),
  action: z.enum(FLAG_ACTIONS),
  flagVersion: z.number().int(),
  actorId: z.string(),
});
/** The whole envelope as it sits on the outbox (aggregate `flags`, key = flag key). */
export const flagChangedEventSchema = z.object({
  eventId: z.string(),
  type: z.literal(FLAG_CHANGED_EVENT_TYPE),
  version: z.literal(1),
  aggregateType: z.literal("flags"),
  aggregateId: z.string(),
  aggregateVersion: z.number().int(),
  occurredAt: z.string(),
  traceparent: z.string().optional(),
  payload: flagChangedPayloadSchema,
});
export type FlagChangedEvent = z.infer<typeof flagChangedEventSchema>;
