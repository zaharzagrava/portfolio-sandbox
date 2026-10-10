import * as joi from 'joi';
import { ConfigRules, RuleCheck } from './config-rules';

/**
 * Validated settings of `discovery` search (S32 FR-061). Defaults are applied here (the loader keeps the raw value).
 * Secrets are validated by `searchSecretsRule`; `search_boost_weights` is a JSON object of weights (cap 4 on the
 * product of all multipliers, enforced by the boost function).
 */
export interface SearchConfig {
  search_budget_ms: number;
  embedding_budget_ms: number;
  search_refresh_interval: string;
  search_tombstone_retention_days: number;
  search_previous_index_retention_hours: number;
  search_registry_ttl_ms: number;
  search_reindex_verify_wait_ms: number;
  search_boost_weights?: string;
  search_log_secret?: string;
  search_id_signing_key?: string;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const int = (name: string, fallback: number): Key => ({
  name,
  verify: joi.number().integer().min(1).required(),
  postProcess: ((v: unknown) =>
    v === undefined ? fallback : Number(v)) as never,
});

export const searchConfigKeys: Record<keyof SearchConfig, Key> = {
  search_budget_ms: int('SEARCH_BUDGET_MS', 1_000),
  embedding_budget_ms: int('EMBEDDING_BUDGET_MS', 300),
  search_refresh_interval: {
    name: 'SEARCH_REFRESH_INTERVAL',
    verify: joi
      .string()
      .pattern(/^\d+(ms|s|m)$/)
      .required(),
    postProcess: ((v: unknown) =>
      v === undefined ? '5s' : String(v)) as never,
  },
  search_tombstone_retention_days: int('SEARCH_TOMBSTONE_RETENTION_DAYS', 30),
  search_previous_index_retention_hours: int(
    'SEARCH_PREVIOUS_INDEX_RETENTION_HOURS',
    24,
  ),
  search_registry_ttl_ms: int('SEARCH_REGISTRY_TTL_MS', 1_000),
  search_reindex_verify_wait_ms: int('SEARCH_REINDEX_VERIFY_WAIT_MS', 30_000),
  search_boost_weights: {
    name: 'SEARCH_BOOST_WEIGHTS',
    verify: joi.string().optional().allow(''),
  },
  search_log_secret: {
    name: 'SEARCH_LOG_SECRET',
    verify: joi.string().optional().allow(''),
  },
  search_id_signing_key: {
    name: 'SEARCH_ID_SIGNING_KEY',
    verify: joi.string().optional().allow(''),
  },
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/**
 * Both secrets are required in production, at least 32 bytes, and never the session secret nor each other (the log
 * salt must not let anyone forge a searchId and the reverse). Outside production a missing secret falls back to a
 * per-process random value.
 */
export const searchSecretsRule: RuleCheck = (ctx) => {
  const found: string[] = [];
  const log = ctx.get('search_log_secret');
  const sign = ctx.get('search_id_signing_key');
  for (const [name, value] of [
    ['search_log_secret', log],
    ['search_id_signing_key', sign],
  ] as const) {
    if (ctx.production && !isSet(value)) found.push(`${name} is required`);
    if (!isSet(value)) continue;
    if (Buffer.byteLength(String(value)) < 32)
      found.push(`${name} must be at least 32 bytes`);
    if (value === ctx.get('jwt_secret'))
      found.push(`${name} must differ from jwt_secret`);
  }
  if (isSet(log) && log === sign)
    found.push('search_log_secret must differ from search_id_signing_key');
  const weights = ctx.get('search_boost_weights');
  if (isSet(weights)) {
    try {
      const parsed = JSON.parse(String(weights));
      const num = (v: unknown, min: number) =>
        v === undefined || (typeof v === 'number' && v >= min);
      const tier = parsed?.tier;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !num(parsed.inStock, 1) ||
        !num(parsed.sponsored, 1) ||
        !num(parsed.rating, 0) ||
        !num(parsed.popularity, 0) ||
        (tier !== undefined &&
          (typeof tier !== 'object' ||
            tier === null ||
            Object.values(tier).some((v) => typeof v !== 'number' || v < 1)))
      )
        found.push(
          'search_boost_weights must be {inStock>=1, rating>=0, popularity>=0, tier:{..>=1}, sponsored>=1}',
        );
    } catch {
      found.push('search_boost_weights must be valid JSON');
    }
  }
  return found;
};

ConfigRules.register({
  owner: 'search',
  keys: [
    'search_log_secret',
    'search_id_signing_key',
    'search_boost_weights',
    'jwt_secret',
  ],
  validate: searchSecretsRule,
});
