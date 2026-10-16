import * as joi from 'joi';
import { ConfigRules, RuleCheck } from './config-rules';

/**
 * Validated settings of the ledger and the reconciliation (S14 FR-049, research R-13). Defaults are applied here (the
 * loader keeps the raw value); a value outside its range fails startup naming the setting. The provider key
 * (`stripe_secret_key`) is required by the base config; the cursor secret is checked by `ledgerSecretsRule`.
 */
export interface LedgerConfig {
  ledger_shards: number;
  ledger_lock_timeout_ms: number;
  ledger_statement_timeout_ms: number;
  reconciliation_page_size: number;
  reconciliation_catchup_days: number;
  ledger_read_hot_timeout_ms: number;
  ledger_read_durable_timeout_ms: number;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const int = (name: string, fallback: number, min = 1, max?: number): Key => ({
  name,
  verify: (max === undefined
    ? joi.number().integer().min(min)
    : joi.number().integer().min(min).max(max)
  ).required(),
  postProcess: ((v: unknown) =>
    v === undefined ? fallback : Number(v)) as never,
});

export const ledgerConfigKeys: Record<keyof LedgerConfig, Key> = {
  ledger_shards: int('LEDGER_SHARDS', 32, 1, 256),
  ledger_lock_timeout_ms: int('LEDGER_LOCK_TIMEOUT_MS', 2_000),
  ledger_statement_timeout_ms: int('LEDGER_STATEMENT_TIMEOUT_MS', 5_000),
  reconciliation_page_size: int('RECONCILIATION_PAGE_SIZE', 100, 1, 100),
  reconciliation_catchup_days: int('RECONCILIATION_CATCHUP_DAYS', 7, 1, 30),
  ledger_read_hot_timeout_ms: int('LEDGER_READ_HOT_TIMEOUT_MS', 100),
  ledger_read_durable_timeout_ms: int('LEDGER_READ_DURABLE_TIMEOUT_MS', 300),
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/** The cursor signing secret: required in production, at least 32 bytes whenever set, and never the session secret. */
export const ledgerSecretsRule: RuleCheck = (ctx) => {
  const found: string[] = [];
  const cursor = ctx.get('ledger_cursor_secret');
  if (ctx.production && !isSet(cursor))
    found.push('ledger_cursor_secret is required');
  if (isSet(cursor)) {
    if (Buffer.byteLength(String(cursor)) < 32)
      found.push('ledger_cursor_secret must be at least 32 bytes');
    if (cursor === ctx.get('jwt_secret'))
      found.push('ledger_cursor_secret must differ from jwt_secret');
  }
  return found;
};

ConfigRules.register({
  owner: 'ledger',
  keys: ['ledger_cursor_secret', 'jwt_secret'],
  validate: ledgerSecretsRule,
});
