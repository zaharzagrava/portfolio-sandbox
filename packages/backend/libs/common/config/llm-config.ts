import * as joi from 'joi';

/**
 * Settings of the model provider (S46 AS-74). Keys and defaults live here, with the other `*-config.ts` files, so the
 * config service can read them; the startup check that needs the price table (`assertLlmConfig`) lives with the provider
 * in `@app/infrastructure/llm`. Defaults are applied once (the loader keeps the raw value); a violation names the key,
 * never its value. There is no `?? 'claude-...'` anywhere else.
 */
export interface LlmConfig {
  /** `scripted` only outside production and only when set explicitly; a missing key never selects it. Default anthropic. */
  llm_provider?: 'anthropic' | 'scripted';
  anthropic_api_key?: string;
  assistant_model: string;
  /** Used when the main model fails before the first token. */
  assistant_fallback_model: string;
  /** Conversation compaction. */
  assistant_summary_model: string;
  /** The cost/quality lever after caching. */
  assistant_effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Abort the provider call after nobody watched the stream this long. */
  assistant_detach_grace_ms: number;
  assistant_max_active_turns: number;
  assistant_first_token_timeout_ms: number;
  assistant_call_timeout_ms: number;
  assistant_turn_timeout_ms: number;
  assistant_tool_timeout_ms: number;
  /** At most 25 000: proxies idle out. */
  assistant_heartbeat_ms: number;
  assistant_replay_window_ms: number;
  assistant_drain_ms: number;
  /** Default on in production. */
  assistant_require_distinct_fallback?: boolean;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const int = (name: string, fallback: number, min = 0): Key => ({
  name,
  verify: joi.number().integer().min(min).required(),
  postProcess: ((v: unknown) =>
    v === undefined || v === '' ? fallback : Number(v)) as never,
});
const text = (name: string, fallback: string): Key => ({
  name,
  verify: joi.string().min(1).required(),
  postProcess: ((v: unknown) =>
    v === undefined || v === '' ? fallback : (v as string)) as never,
});
const optionalText = (name: string): Key => ({
  name,
  verify: joi.string().optional().allow(''),
});

export const llmConfigKeys: Record<keyof LlmConfig, Key> = {
  llm_provider: {
    name: 'LLM_PROVIDER',
    verify: joi.string().valid('anthropic', 'scripted').optional().allow(''),
  },
  anthropic_api_key: optionalText('ANTHROPIC_API_KEY'),
  assistant_model: text('ASSISTANT_MODEL', 'claude-opus-5-5'),
  assistant_fallback_model: text(
    'ASSISTANT_FALLBACK_MODEL',
    'claude-sonnet-5-5',
  ),
  assistant_summary_model: text('ASSISTANT_SUMMARY_MODEL', 'claude-haiku-4-5'),
  assistant_effort: {
    name: 'ASSISTANT_EFFORT',
    verify: joi
      .string()
      .valid('low', 'medium', 'high', 'xhigh', 'max')
      .required(),
    postProcess: ((v: unknown) =>
      v === undefined || v === '' ? 'low' : v) as never,
  },
  assistant_detach_grace_ms: int('ASSISTANT_DETACH_GRACE_MS', 10_000),
  assistant_max_active_turns: int('ASSISTANT_MAX_ACTIVE_TURNS', 3, 1),
  assistant_first_token_timeout_ms: int(
    'ASSISTANT_FIRST_TOKEN_TIMEOUT_MS',
    30_000,
    1,
  ),
  assistant_call_timeout_ms: int('ASSISTANT_CALL_TIMEOUT_MS', 120_000, 1),
  assistant_turn_timeout_ms: int('ASSISTANT_TURN_TIMEOUT_MS', 240_000, 1),
  assistant_tool_timeout_ms: int('ASSISTANT_TOOL_TIMEOUT_MS', 5_000, 1),
  assistant_heartbeat_ms: int('ASSISTANT_HEARTBEAT_MS', 15_000, 1),
  assistant_replay_window_ms: int('ASSISTANT_REPLAY_WINDOW_MS', 900_000, 1),
  assistant_drain_ms: int('ASSISTANT_DRAIN_MS', 25_000, 1),
  assistant_require_distinct_fallback: {
    name: 'ASSISTANT_REQUIRE_DISTINCT_FALLBACK',
    verify: joi.boolean().optional().allow(''),
    postProcess: ((v: unknown) =>
      v === undefined || v === ''
        ? undefined
        : v === true || v === 'true') as never,
  },
};

export const MAX_HEARTBEAT_MS = 25_000;

const LIMIT_KEYS = [
  'assistant_detach_grace_ms',
  'assistant_max_active_turns',
  'assistant_first_token_timeout_ms',
  'assistant_call_timeout_ms',
  'assistant_turn_timeout_ms',
  'assistant_tool_timeout_ms',
  'assistant_heartbeat_ms',
  'assistant_replay_window_ms',
  'assistant_drain_ms',
] as const;

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/**
 * Every violation of the table in AS-74, one message each, naming the key. `get` reads parsed values (defaults applied),
 * so the same check serves the loader's output and a plain object in a unit test. `isPriced` is the provider's price
 * table (a model without a price is a startup error, never priced silently).
 */
export function llmConfigViolations(
  get: (key: string) => unknown,
  production: boolean,
  isPriced: (model: string) => boolean,
): string[] {
  const found: string[] = [];
  const provider = isSet(get('llm_provider'))
    ? get('llm_provider')
    : 'anthropic';
  if (provider === 'scripted' && production)
    found.push('llm_provider "scripted" is not allowed in production');
  if (provider === 'anthropic' && !isSet(get('anthropic_api_key')))
    found.push(
      'anthropic_api_key is required for the anthropic provider (set llm_provider=scripted for keyless development)',
    );
  for (const key of [
    'assistant_model',
    'assistant_fallback_model',
    'assistant_summary_model',
  ]) {
    const model = get(key);
    if (typeof model !== 'string' || !isPriced(model))
      found.push(`${key} names a model that is not in the price table`);
  }
  for (const key of LIMIT_KEYS) {
    const value = get(key);
    if (!Number.isInteger(value) || (value as number) < 0)
      found.push(`${key} must be a non-negative integer`);
  }
  const heartbeat = get('assistant_heartbeat_ms');
  if (typeof heartbeat === 'number' && heartbeat > MAX_HEARTBEAT_MS)
    found.push(
      `assistant_heartbeat_ms must be at most ${MAX_HEARTBEAT_MS} (proxies idle out)`,
    );
  const requireDistinct = isSet(get('assistant_require_distinct_fallback'))
    ? get('assistant_require_distinct_fallback') === true
    : production;
  if (
    requireDistinct &&
    get('assistant_model') === get('assistant_fallback_model')
  )
    found.push(
      'assistant_fallback_model must differ from assistant_model (assistant_require_distinct_fallback)',
    );
  return found;
}

export class LlmConfigError extends Error {
  constructor(readonly violations: string[]) {
    super(
      `Config validation error: ${violations.map((v) => `[llm] ${v}`).join('; ')}`,
    );
    this.name = 'LlmConfigError';
  }
}
