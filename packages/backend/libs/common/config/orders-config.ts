import * as joi from 'joi';
import { ConfigRules, RuleCheck } from './config-rules';

/**
 * Validated settings of `orders` (S10 FR-058). Defaults are applied here (the loader keeps the raw value); every
 * number must be a positive integer. Secrets are validated by `ordersSecretsRule`.
 */
export interface OrdersConfig {
  orders_hold_seconds: number;
  orders_cart_max_lines: number;
  orders_cart_max_quantity: number;
  orders_cart_line_ttl_days: number;
  orders_catalog_timeout_ms: number;
  orders_stock_timeout_ms: number;
  orders_discount_timeout_ms: number;
  orders_shops_timeout_ms: number;
  orders_payment_status_timeout_ms: number;
  orders_cart_store_timeout_ms: number;
  orders_lock_timeout_ms: number;
  orders_checkout_budget_ms: number;
  orders_sweeper_batch: number;
  orders_recovery_age_seconds: number;
  orders_webhook_max_attempts: number;
  orders_clear_cart_max_attempts: number;
  orders_inbox_retention_days: number;
  orders_webhook_body_limit_bytes: number;
  /** S11 flash sales (R-12). */
  orders_flash_load_lead_seconds: number;
  orders_flash_min_lead_seconds: number;
  orders_flash_max_window_seconds: number;
  orders_flash_claim_window_seconds: number;
  orders_flash_order_margin_seconds: number;
  orders_flash_verify_interval_seconds: number;
  orders_flash_sweep_interval_seconds: number;
  orders_flash_call_timeout_ms: number;
  orders_flash_public_cache_ms: number;
  orders_flash_reconcile_wait_alert_seconds: number;
  orders_flash_key_ttl_jitter: number;
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

export const ordersConfigKeys: Record<keyof OrdersConfig, Key> = {
  orders_hold_seconds: int('ORDERS_HOLD_SECONDS', 900),
  orders_cart_max_lines: int('ORDERS_CART_MAX_LINES', 50),
  orders_cart_max_quantity: int('ORDERS_CART_MAX_QUANTITY', 20),
  orders_cart_line_ttl_days: int('ORDERS_CART_LINE_TTL_DAYS', 30),
  orders_catalog_timeout_ms: int('ORDERS_CATALOG_TIMEOUT_MS', 1_000),
  orders_stock_timeout_ms: int('ORDERS_STOCK_TIMEOUT_MS', 2_000),
  orders_discount_timeout_ms: int('ORDERS_DISCOUNT_TIMEOUT_MS', 250),
  orders_shops_timeout_ms: int('ORDERS_SHOPS_TIMEOUT_MS', 1_000),
  orders_payment_status_timeout_ms: int(
    'ORDERS_PAYMENT_STATUS_TIMEOUT_MS',
    2_000,
  ),
  orders_cart_store_timeout_ms: int('ORDERS_CART_STORE_TIMEOUT_MS', 500),
  orders_lock_timeout_ms: int('ORDERS_LOCK_TIMEOUT_MS', 100),
  orders_checkout_budget_ms: int('ORDERS_CHECKOUT_BUDGET_MS', 10_000),
  orders_sweeper_batch: int('ORDERS_SWEEPER_BATCH', 200),
  orders_recovery_age_seconds: int('ORDERS_RECOVERY_AGE_SECONDS', 60),
  orders_webhook_max_attempts: int('ORDERS_WEBHOOK_MAX_ATTEMPTS', 8),
  orders_clear_cart_max_attempts: int('ORDERS_CLEAR_CART_MAX_ATTEMPTS', 5),
  orders_inbox_retention_days: int('ORDERS_INBOX_RETENTION_DAYS', 35),
  orders_webhook_body_limit_bytes: int(
    'ORDERS_WEBHOOK_BODY_LIMIT_BYTES',
    65_536,
  ),
  orders_flash_load_lead_seconds: int('ORDERS_FLASH_LOAD_LEAD_SECONDS', 60),
  orders_flash_min_lead_seconds: int('ORDERS_FLASH_MIN_LEAD_SECONDS', 120),
  orders_flash_max_window_seconds: int(
    'ORDERS_FLASH_MAX_WINDOW_SECONDS',
    86_400,
  ),
  orders_flash_claim_window_seconds: int(
    'ORDERS_FLASH_CLAIM_WINDOW_SECONDS',
    60,
  ),
  orders_flash_order_margin_seconds: int(
    'ORDERS_FLASH_ORDER_MARGIN_SECONDS',
    20,
  ),
  orders_flash_verify_interval_seconds: int(
    'ORDERS_FLASH_VERIFY_INTERVAL_SECONDS',
    30,
  ),
  orders_flash_sweep_interval_seconds: int(
    'ORDERS_FLASH_SWEEP_INTERVAL_SECONDS',
    10,
  ),
  orders_flash_call_timeout_ms: int('ORDERS_FLASH_CALL_TIMEOUT_MS', 100),
  orders_flash_public_cache_ms: int('ORDERS_FLASH_PUBLIC_CACHE_MS', 1_000),
  orders_flash_reconcile_wait_alert_seconds: int(
    'ORDERS_FLASH_RECONCILE_WAIT_ALERT_SECONDS',
    600,
  ),
  orders_flash_key_ttl_jitter: {
    name: 'ORDERS_FLASH_KEY_TTL_JITTER',
    verify: joi.number().min(0).max(0.99).required(),
    postProcess: ((v: unknown) => (v === undefined ? 0.1 : Number(v))) as never,
  },
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/**
 * The cart cookie secret must be at least 32 bytes and never the session secret; in production both secrets are
 * required (outside production a missing cart secret falls back to a per-process random value, a missing webhook
 * secret refuses every webhook). The previous webhook secret may only be set next to the current one.
 */
export const ordersSecretsRule: RuleCheck = (ctx) => {
  const found: string[] = [];
  const cart = ctx.get('cart_cookie_secret');
  if (ctx.production && !isSet(cart))
    found.push('cart_cookie_secret is required');
  if (isSet(cart)) {
    if (Buffer.byteLength(String(cart)) < 32)
      found.push('cart_cookie_secret must be at least 32 bytes');
    if (cart === ctx.get('jwt_secret'))
      found.push('cart_cookie_secret must differ from jwt_secret');
  }
  const current = ctx.get('stripe_webhook_secret');
  if (ctx.production && !isSet(current))
    found.push('stripe_webhook_secret is required');
  if (isSet(ctx.get('stripe_webhook_secret_previous')) && !isSet(current))
    found.push('stripe_webhook_secret_previous requires stripe_webhook_secret');
  return found;
};

/** S11 flash-sale start-up rules (R-12): a value missing here falls back to the default of its key. */
export const ordersFlashRule: RuleCheck = (ctx) => {
  const num = (key: string, fallback: number): number => {
    const v = ctx.get(key);
    return isSet(v) ? Number(v) : fallback;
  };
  const found: string[] = [];
  if (
    num('orders_flash_order_margin_seconds', 20) >=
    num('orders_flash_claim_window_seconds', 60)
  )
    found.push(
      'orders_flash_order_margin_seconds must be less than orders_flash_claim_window_seconds',
    );
  if (
    num('orders_flash_load_lead_seconds', 60) >=
    num('orders_flash_min_lead_seconds', 120)
  )
    found.push(
      'orders_flash_load_lead_seconds must be less than orders_flash_min_lead_seconds',
    );
  if (num('orders_flash_call_timeout_ms', 100) > 1000)
    found.push('orders_flash_call_timeout_ms must be at most 1000');
  const jitter = num('orders_flash_key_ttl_jitter', 0.1);
  if (jitter < 0 || jitter >= 1)
    found.push('orders_flash_key_ttl_jitter must be below 1');
  return found;
};

ConfigRules.register({
  owner: 'orders',
  keys: [
    'orders_flash_order_margin_seconds',
    'orders_flash_claim_window_seconds',
    'orders_flash_load_lead_seconds',
    'orders_flash_min_lead_seconds',
    'orders_flash_call_timeout_ms',
    'orders_flash_key_ttl_jitter',
  ],
  validate: ordersFlashRule,
});

ConfigRules.register({
  owner: 'orders',
  keys: [
    'cart_cookie_secret',
    'jwt_secret',
    'stripe_webhook_secret',
    'stripe_webhook_secret_previous',
  ],
  validate: ordersSecretsRule,
});
