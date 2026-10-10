import * as joi from 'joi';
import { ConfigRules, RuleCheck } from './config-rules';

/**
 * Validated settings of `payments` (S13 FR-060, specs/domains/S13-payment-intents/contracts/services.md). Defaults are
 * applied here (the loader keeps the raw value); every number must be a positive integer, so a zero or negative limit
 * fails startup naming the setting. The provider key (`stripe_secret_key`) is required by the base config; the cursor
 * secret is checked by `paymentsSecretsRule`.
 */
export interface PaymentsConfig {
  payments_create_timeout_ms: number;
  payments_refund_timeout_ms: number;
  payments_lookup_timeout_ms: number;
  payments_cancel_timeout_ms: number;
  payments_refresh_timeout_ms: number;
  payments_connect_timeout_ms: number;
  payments_breaker_window_ms: number;
  payments_breaker_min_calls: number;
  payments_breaker_failure_pct: number;
  payments_breaker_open_ms: number;
  payments_breaker_slow_ms: number;
  payments_charge_max_attempts: number;
  payments_charge_deadline_seconds: number;
  payments_charge_backoff_base_ms: number;
  payments_charge_backoff_cap_ms: number;
  payments_resolve_first_delay_ms: number;
  payments_resolve_backoff_cap_ms: number;
  payments_resolve_no_record_seconds: number;
  payments_stuck_seconds: number;
  payments_sweep_interval_seconds: number;
  payments_sweep_batch: number;
  payments_refund_backoff_base_ms: number;
  payments_refund_backoff_cap_ms: number;
  payments_refund_window_seconds: number;
  payments_refund_batch: number;
  payments_order_copy_wait_ms: number;
  payments_refresh_min_interval_ms: number;
  payments_page_default: number;
  payments_page_max: number;
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

export const paymentsConfigKeys: Record<keyof PaymentsConfig, Key> = {
  payments_create_timeout_ms: int('PAYMENTS_CREATE_TIMEOUT_MS', 8_000),
  payments_refund_timeout_ms: int('PAYMENTS_REFUND_TIMEOUT_MS', 8_000),
  payments_lookup_timeout_ms: int('PAYMENTS_LOOKUP_TIMEOUT_MS', 4_000),
  payments_cancel_timeout_ms: int('PAYMENTS_CANCEL_TIMEOUT_MS', 4_000),
  payments_refresh_timeout_ms: int('PAYMENTS_REFRESH_TIMEOUT_MS', 2_000),
  payments_connect_timeout_ms: int('PAYMENTS_CONNECT_TIMEOUT_MS', 2_000),
  payments_breaker_window_ms: int('PAYMENTS_BREAKER_WINDOW_MS', 10_000),
  payments_breaker_min_calls: int('PAYMENTS_BREAKER_MIN_CALLS', 10),
  payments_breaker_failure_pct: int('PAYMENTS_BREAKER_FAILURE_PCT', 50),
  payments_breaker_open_ms: int('PAYMENTS_BREAKER_OPEN_MS', 30_000),
  payments_breaker_slow_ms: int('PAYMENTS_BREAKER_SLOW_MS', 5_000),
  payments_charge_max_attempts: int('PAYMENTS_CHARGE_MAX_ATTEMPTS', 6),
  payments_charge_deadline_seconds: int(
    'PAYMENTS_CHARGE_DEADLINE_SECONDS',
    600,
  ),
  payments_charge_backoff_base_ms: int(
    'PAYMENTS_CHARGE_BACKOFF_BASE_MS',
    2_000,
  ),
  payments_charge_backoff_cap_ms: int('PAYMENTS_CHARGE_BACKOFF_CAP_MS', 60_000),
  payments_resolve_first_delay_ms: int(
    'PAYMENTS_RESOLVE_FIRST_DELAY_MS',
    30_000,
  ),
  payments_resolve_backoff_cap_ms: int(
    'PAYMENTS_RESOLVE_BACKOFF_CAP_MS',
    900_000,
  ),
  payments_resolve_no_record_seconds: int(
    'PAYMENTS_RESOLVE_NO_RECORD_SECONDS',
    3_600,
  ),
  payments_stuck_seconds: int('PAYMENTS_STUCK_SECONDS', 86_400),
  payments_sweep_interval_seconds: int('PAYMENTS_SWEEP_INTERVAL_SECONDS', 60),
  payments_sweep_batch: int('PAYMENTS_SWEEP_BATCH', 200),
  payments_refund_backoff_base_ms: int(
    'PAYMENTS_REFUND_BACKOFF_BASE_MS',
    30_000,
  ),
  payments_refund_backoff_cap_ms: int(
    'PAYMENTS_REFUND_BACKOFF_CAP_MS',
    900_000,
  ),
  payments_refund_window_seconds: int('PAYMENTS_REFUND_WINDOW_SECONDS', 86_400),
  payments_refund_batch: int('PAYMENTS_REFUND_BATCH', 100),
  payments_order_copy_wait_ms: int('PAYMENTS_ORDER_COPY_WAIT_MS', 2_000),
  payments_refresh_min_interval_ms: int(
    'PAYMENTS_REFRESH_MIN_INTERVAL_MS',
    2_000,
  ),
  payments_page_default: int('PAYMENTS_PAGE_DEFAULT', 20),
  payments_page_max: int('PAYMENTS_PAGE_MAX', 100),
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/** The cursor signing secret: required in production, at least 32 bytes whenever set, and never the session secret. */
export const paymentsSecretsRule: RuleCheck = (ctx) => {
  const found: string[] = [];
  const cursor = ctx.get('payments_cursor_secret');
  if (ctx.production && !isSet(cursor))
    found.push('payments_cursor_secret is required');
  if (isSet(cursor)) {
    if (Buffer.byteLength(String(cursor)) < 32)
      found.push('payments_cursor_secret must be at least 32 bytes');
    if (cursor === ctx.get('jwt_secret'))
      found.push('payments_cursor_secret must differ from jwt_secret');
  }
  return found;
};

ConfigRules.register({
  owner: 'payments',
  keys: ['payments_cursor_secret', 'jwt_secret'],
  validate: paymentsSecretsRule,
});
