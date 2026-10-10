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
