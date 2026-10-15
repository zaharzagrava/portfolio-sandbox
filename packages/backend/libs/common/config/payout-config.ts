import * as joi from 'joi';
import { ConfigRules, type RuleCheck } from './config-rules';

/**
 * Validated settings of the seller payouts (S15 FR-048, AS-54, research R-14). Defaults are applied here (the loader
 * keeps the raw value); a value outside its range fails startup naming the setting and never prints a secret. The
 * provider credential is the base `stripe_secret_key`; the cursor secret falls back to the ledger's.
 */
export interface PayoutConfig {
  /** Platform default reserve in basis points of the available balance (a shop can override it). */
  payout_default_reserve_bps: number;
  /** Smallest payout (minor units), checked on the balance and again after the reserve. */
  payout_min_minor: number;
  /** Largest single payout (minor units); the rest rolls to the next week. */
  payout_cap_minor: number;
  /** Hours a changed destination is skipped before it receives money. */
  payout_destination_cooling_hours: number;
  /** Timeout of every provider call (transfer and lookup). */
  payout_provider_timeout_ms: number;
  /** Job attempts for `payouts.send` (transient answers are retried at this layer only). */
  payout_send_max_attempts: number;
  /** Same-key re-sends the resolver may make when the provider does not know a transfer. */
  payout_resolver_max_resends: number;
  /** A payout `SENDING` for longer than this is looked up by the resolver. */
  payout_stale_sending_ms: number;
  /** Hours in doubt before the one `payout.in_doubt` event. */
  payout_in_doubt_after_hours: number;
  payout_cursor_secret?: string;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const int = (
  name: string,
  fallback: number,
  min: number,
  max?: number,
): Key => ({
  name,
  verify: (max === undefined
    ? joi.number().integer().min(min)
    : joi.number().integer().min(min).max(max)
  ).required(),
  postProcess: ((v: unknown) =>
    v === undefined || v === '' ? fallback : Number(v)) as never,
});

export const PAYOUT_DEFAULTS = {
  payout_default_reserve_bps: 1000,
  payout_min_minor: 1000,
  payout_cap_minor: 5_000_000,
  payout_destination_cooling_hours: 48,
  payout_provider_timeout_ms: 10_000,
  payout_send_max_attempts: 5,
  payout_resolver_max_resends: 3,
  payout_stale_sending_ms: 300_000,
  payout_in_doubt_after_hours: 24,
} as const;

export const payoutConfigKeys: Record<
  Exclude<keyof PayoutConfig, 'payout_cursor_secret'>,
  Key
> = {
  payout_default_reserve_bps: int(
    'PAYOUT_DEFAULT_RESERVE_BPS',
    PAYOUT_DEFAULTS.payout_default_reserve_bps,
    0,
    5000,
  ),
  payout_min_minor: int(
    'PAYOUT_MIN_MINOR',
    PAYOUT_DEFAULTS.payout_min_minor,
    1,
  ),
  payout_cap_minor: int(
    'PAYOUT_CAP_MINOR',
    PAYOUT_DEFAULTS.payout_cap_minor,
    1,
  ),
  payout_destination_cooling_hours: int(
    'PAYOUT_DESTINATION_COOLING_HOURS',
    PAYOUT_DEFAULTS.payout_destination_cooling_hours,
    0,
  ),
  payout_provider_timeout_ms: int(
    'PAYOUT_PROVIDER_TIMEOUT_MS',
    PAYOUT_DEFAULTS.payout_provider_timeout_ms,
    1,
  ),
  payout_send_max_attempts: int(
    'PAYOUT_SEND_MAX_ATTEMPTS',
    PAYOUT_DEFAULTS.payout_send_max_attempts,
    1,
    10,
  ),
  payout_resolver_max_resends: int(
    'PAYOUT_RESOLVER_MAX_RESENDS',
    PAYOUT_DEFAULTS.payout_resolver_max_resends,
    0,
    10,
  ),
  payout_stale_sending_ms: int(
    'PAYOUT_STALE_SENDING_MS',
    PAYOUT_DEFAULTS.payout_stale_sending_ms,
    1,
  ),
  payout_in_doubt_after_hours: int(
    'PAYOUT_IN_DOUBT_AFTER_HOURS',
    PAYOUT_DEFAULTS.payout_in_doubt_after_hours,
    1,
  ),
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/** `cap >= min`, with the defaults filling a side that is not set. */
export const payoutLimitsRule: RuleCheck = (ctx) => {
  const min = isSet(ctx.get('payout_min_minor'))
    ? Number(ctx.get('payout_min_minor'))
    : PAYOUT_DEFAULTS.payout_min_minor;
  const cap = isSet(ctx.get('payout_cap_minor'))
    ? Number(ctx.get('payout_cap_minor'))
    : PAYOUT_DEFAULTS.payout_cap_minor;
  return cap < min
    ? ['payout_cap_minor must be at least payout_min_minor']
    : [];
};

/**
 * The cursor signing secret: at least 32 bytes whenever set, never the session secret, and required in production
 * unless the ledger's cursor secret (the fallback) is set. Messages carry key names only.
 */
export const payoutSecretsRule: RuleCheck = (ctx) => {
  const found: string[] = [];
  const cursor = ctx.get('payout_cursor_secret');
  if (
    ctx.production &&
    !isSet(cursor) &&
    !isSet(ctx.get('ledger_cursor_secret'))
  )
    found.push('payout_cursor_secret is required');
  if (isSet(cursor)) {
    if (Buffer.byteLength(String(cursor)) < 32)
      found.push('payout_cursor_secret must be at least 32 bytes');
    if (cursor === ctx.get('jwt_secret'))
      found.push('payout_cursor_secret must differ from jwt_secret');
  }
  return found;
};

ConfigRules.register({
  owner: 'payouts',
  keys: ['payout_min_minor', 'payout_cap_minor'],
  validate: payoutLimitsRule,
});
ConfigRules.register({
  owner: 'payouts',
  keys: ['payout_cursor_secret', 'ledger_cursor_secret', 'jwt_secret'],
  validate: payoutSecretsRule,
});
