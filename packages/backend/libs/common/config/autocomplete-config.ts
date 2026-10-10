import * as joi from 'joi';
import { ConfigRules } from './config-rules';

/**
 * Validated settings of `discovery` autocomplete (S33 FR-039). Defaults are applied here (the loader keeps the raw
 * value); an invalid value fails startup naming the key (never the value). The blocklist is a comma-separated list of
 * whole words, policy rather than code.
 */
export interface AutocompleteConfig {
  autocomplete_catalog_budget_ms: number;
  autocomplete_typo_budget_ms: number;
  autocomplete_k: number;
  autocomplete_depth: number;
  autocomplete_min_searchers: number;
  autocomplete_window_days: number;
  autocomplete_cap: number;
  autocomplete_poll_ms: number;
  autocomplete_retention_count: number;
  autocomplete_retention_grace_ms: number;
  autocomplete_log_query_timeout_ms: number;
  autocomplete_blocklist: string;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const int = (name: string, fallback: number, max: number): Key => ({
  name,
  verify: joi.number().integer().min(1).max(max).required(),
  postProcess: ((v: unknown) =>
    v === undefined ? fallback : Number(v)) as never,
});

const DEFAULT_BLOCKLIST = 'fake,counterfeit,stolen,hack,hacked';

export const autocompleteConfigKeys: Record<keyof AutocompleteConfig, Key> = {
  autocomplete_catalog_budget_ms: int(
    'AUTOCOMPLETE_CATALOG_BUDGET_MS',
    40,
    1_000,
  ),
  autocomplete_typo_budget_ms: int('AUTOCOMPLETE_TYPO_BUDGET_MS', 40, 1_000),
  autocomplete_k: int('AUTOCOMPLETE_K', 10, 100),
  autocomplete_depth: int('AUTOCOMPLETE_DEPTH', 20, 100),
  autocomplete_min_searchers: int('AUTOCOMPLETE_MIN_SEARCHERS', 5, 1_000_000),
  autocomplete_window_days: int('AUTOCOMPLETE_WINDOW_DAYS', 30, 90),
  autocomplete_cap: int('AUTOCOMPLETE_CAP', 200_000, 5_000_000),
  autocomplete_poll_ms: int('AUTOCOMPLETE_POLL_MS', 30_000, 3_600_000),
  autocomplete_retention_count: int('AUTOCOMPLETE_RETENTION_COUNT', 5, 100),
  autocomplete_retention_grace_ms: int(
    'AUTOCOMPLETE_RETENTION_GRACE_MS',
    3_600_000,
    7 * 86_400_000,
  ),
  // below the 600 s job `maxRuntimeMs`, so a slow log store fails the run before the worker aborts it
  autocomplete_log_query_timeout_ms: int(
    'AUTOCOMPLETE_LOG_QUERY_TIMEOUT_MS',
    300_000,
    590_000,
  ),
  autocomplete_blocklist: {
    name: 'AUTOCOMPLETE_BLOCKLIST',
    verify: joi.string().allow('').required(),
    postProcess: ((v: unknown) =>
      typeof v === 'string' ? v : DEFAULT_BLOCKLIST) as never,
  },
};

ConfigRules.register({
  owner: 'autocomplete',
  keys: ['autocomplete_blocklist', 'autocomplete_k', 'autocomplete_cap'],
  validate: (ctx) => {
    const found: string[] = [];
    const raw = ctx.get('autocomplete_blocklist');
    if (typeof raw === 'string' && raw.length > 0) {
      const words = raw.split(',').map((w) => w.trim());
      if (words.some((w) => w.length === 0 || /[\s\\]/.test(w)))
        found.push(
          'autocomplete_blocklist must be comma-separated single words',
        );
    }
    return found;
  },
});
