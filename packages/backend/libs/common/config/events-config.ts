import * as joi from 'joi';
import { ConfigRules, RuleCheck } from './config-rules';

/**
 * Validated settings of the event backbone (S53 FR-064): relay, consumer framework, read-your-writes, topics.
 * Defaults are applied here (the config loader keeps the raw value) and every number must be a positive integer.
 */
export interface EventsConfig {
  outbox_relay: 'poller' | 'cdc';
  outbox_relay_interval_ms: number;
  outbox_relay_batch: number;
  outbox_relay_lease_ms: number;
  outbox_relay_max_attempts: number;
  outbox_retention_days: number;
  consumer_batch: number;
  consumer_max_attempts: number;
  consumer_backoff_min_ms: number;
  consumer_backoff_max_ms: number;
  consumer_handler_timeout_ms: number;
  consumer_in_flight: number;
  consumer_graceful_stop_ms: number;
  /** Group session: a member that sends no heartbeat for this long is evicted (kafka minimum 6 s). */
  consumer_session_timeout_ms: number;
  ryw_wait_budget_ms: number;
  ryw_checkpoint_ttl_s: number;
  /** Largest lag (events) at which `projections:promote` still switches; 0 = fully caught up. */
  projection_promotion_max_lag: number;
  topic_default_partitions: number;
  topic_hot_partitions: number;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const int = (name: string, fallback: number, max?: number, min = 1): Key => {
  let verify = joi.number().integer().min(min);
  if (max !== undefined) verify = verify.max(max);
  return {
    name,
    verify: verify.required(),
    // `Number('')` is 0 and `Number('x')` NaN: both fail the validation above, an unset value takes the default.
    postProcess: ((v: unknown) =>
      v === undefined ? fallback : Number(v)) as never,
  };
};

export const eventsConfigKeys: Record<keyof EventsConfig, Key> = {
  outbox_relay: {
    name: 'OUTBOX_RELAY',
    verify: joi.string().valid('poller', 'cdc').required(),
    postProcess: ((v: unknown) => v ?? 'poller') as never,
  },
  outbox_relay_interval_ms: int('OUTBOX_RELAY_INTERVAL_MS', 2_000),
  outbox_relay_batch: int('OUTBOX_RELAY_BATCH', 100),
  outbox_relay_lease_ms: int('OUTBOX_RELAY_LEASE_MS', 30_000),
  outbox_relay_max_attempts: int('OUTBOX_RELAY_MAX_ATTEMPTS', 10),
  outbox_retention_days: int('OUTBOX_RETENTION_DAYS', 7),
  consumer_batch: int('CONSUMER_BATCH', 100),
  consumer_max_attempts: int('CONSUMER_MAX_ATTEMPTS', 3),
  consumer_backoff_min_ms: int('CONSUMER_BACKOFF_MIN_MS', 200),
  consumer_backoff_max_ms: int('CONSUMER_BACKOFF_MAX_MS', 5_000),
  consumer_handler_timeout_ms: int('CONSUMER_HANDLER_TIMEOUT_MS', 30_000),
  consumer_in_flight: int('CONSUMER_IN_FLIGHT', 500),
  consumer_graceful_stop_ms: int('CONSUMER_GRACEFUL_STOP_MS', 20_000),
  consumer_session_timeout_ms: int(
    'CONSUMER_SESSION_TIMEOUT_MS',
    30_000,
    300_000,
    6_000,
  ),
  ryw_wait_budget_ms: int('RYW_WAIT_BUDGET_MS', 500, 2_000),
  ryw_checkpoint_ttl_s: int('RYW_CHECKPOINT_TTL_S', 86_400),
  projection_promotion_max_lag: int(
    'PROJECTION_PROMOTION_MAX_LAG',
    1_000,
    undefined,
    0,
  ),
  topic_default_partitions: int('TOPIC_DEFAULT_PARTITIONS', 12),
  topic_hot_partitions: int('TOPIC_HOT_PARTITIONS', 64),
};

/** Cross-field rule: the consumer backoff window must be ordered. Registered with the process-wide rule set. */
export const eventsConfigRule: RuleCheck = (ctx) => {
  const min = ctx.get('consumer_backoff_min_ms');
  const max = ctx.get('consumer_backoff_max_ms');
  return typeof min === 'number' && typeof max === 'number' && min > max
    ? ['consumer_backoff_min_ms must not exceed consumer_backoff_max_ms']
    : [];
};

ConfigRules.register({
  owner: 'events',
  keys: ['consumer_backoff_min_ms', 'consumer_backoff_max_ms'],
  validate: eventsConfigRule,
});
