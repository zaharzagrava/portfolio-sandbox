import { z } from 'zod';

/**
 * Extraction and retention numbers of S04 (AS-69, A36). `resolveExtractionConfig` takes the configuration values by
 * their keys, applies the defaults, cross-checks them and throws one error naming every broken key (never a value).
 * The module resolves it once at start, so a contradiction is a startup failure.
 */
export const EXTRACTION_DEFAULTS = {
  extractionModel: 'claude-haiku-4-5',
  escalationModel: 'claude-opus-5-5',
  nameMatchThreshold: 0.6,
  statementMaxAgeDays: 180,
  modelTimeoutMs: 45_000,
  leaseMs: 300_000,
  maxAttempts: 2,
  linkTtlSeconds: 300,
  grantTtlSeconds: 900,
  rawRetentionDays: 30,
  recordRetentionDays: 1825,
  queueVisibilitySeconds: 270,
} as const;

export type ExtractionConfig = {
  [
    K in keyof typeof EXTRACTION_DEFAULTS
  ]: (typeof EXTRACTION_DEFAULTS)[K] extends number ? number : string;
};

/** Receives per message before a message is parked: the queue visibility must cover this many model timeouts. */
const VISIBILITY_FACTOR = 6;

const positiveInt = z.number().int().min(1);
const model = z
  .string()
  .refine((v) => v.trim().length > 0, 'must not be empty');

const schema = z
  .object({
    onboarding_extraction_model: model,
    onboarding_escalation_model: model,
    onboarding_name_match_threshold: z.number().min(0).max(1),
    onboarding_statement_max_age_days: positiveInt,
    onboarding_model_timeout_ms: positiveInt,
    onboarding_lease_ms: positiveInt,
    onboarding_max_attempts: z.literal(2),
    onboarding_link_ttl_seconds: positiveInt,
    onboarding_grant_ttl_seconds: positiveInt,
    onboarding_raw_retention_days: positiveInt,
    onboarding_record_retention_days: positiveInt,
    onboarding_queue_visibility_seconds: positiveInt,
  })
  .superRefine((c, ctx) => {
    if (
      c.onboarding_extraction_model.trim() ===
      c.onboarding_escalation_model.trim()
    )
      ctx.addIssue({
        code: 'custom',
        path: ['onboarding_escalation_model'],
        message: 'must differ from onboarding_extraction_model',
      });
    if (c.onboarding_lease_ms <= c.onboarding_model_timeout_ms)
      ctx.addIssue({
        code: 'custom',
        path: ['onboarding_lease_ms'],
        message: 'must be longer than onboarding_model_timeout_ms',
      });
    if (
      c.onboarding_queue_visibility_seconds * 1000 <
      VISIBILITY_FACTOR * c.onboarding_model_timeout_ms
    )
      ctx.addIssue({
        code: 'custom',
        path: ['onboarding_queue_visibility_seconds'],
        message: `must be at least ${VISIBILITY_FACTOR} times onboarding_model_timeout_ms`,
      });
  });

const KEYS = {
  onboarding_extraction_model: 'extractionModel',
  onboarding_escalation_model: 'escalationModel',
  onboarding_name_match_threshold: 'nameMatchThreshold',
  onboarding_statement_max_age_days: 'statementMaxAgeDays',
  onboarding_model_timeout_ms: 'modelTimeoutMs',
  onboarding_lease_ms: 'leaseMs',
  onboarding_max_attempts: 'maxAttempts',
  onboarding_link_ttl_seconds: 'linkTtlSeconds',
  onboarding_grant_ttl_seconds: 'grantTtlSeconds',
  onboarding_raw_retention_days: 'rawRetentionDays',
  onboarding_record_retention_days: 'recordRetentionDays',
  onboarding_queue_visibility_seconds: 'queueVisibilitySeconds',
} as const satisfies Record<
  keyof z.input<typeof schema>,
  keyof ExtractionConfig
>;

export type ExtractionConfigKey = keyof typeof KEYS;
export const EXTRACTION_CONFIG_KEYS = Object.keys(
  KEYS,
) as ExtractionConfigKey[];

export function resolveExtractionConfig(
  raw: Record<string, unknown> = {},
): ExtractionConfig {
  // Unset (undefined/null) takes the default; an empty string is a value and fails like any other bad one.
  const candidate = Object.fromEntries(
    EXTRACTION_CONFIG_KEYS.map((key) => {
      const value = raw[key];
      return [
        key,
        value === undefined || value === null
          ? EXTRACTION_DEFAULTS[KEYS[key]]
          : value,
      ];
    }),
  );
  const parsed = schema.safeParse(candidate);
  if (!parsed.success)
    throw new Error(
      `Invalid onboarding extraction configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || 'config'} ${i.message}`)
        .join('; ')}`,
    );
  const out: Record<string, unknown> = {};
  for (const key of EXTRACTION_CONFIG_KEYS)
    out[KEYS[key]] = (parsed.data as Record<string, unknown>)[key];
  return out as unknown as ExtractionConfig;
}
