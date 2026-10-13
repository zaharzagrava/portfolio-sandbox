import * as joi from 'joi';
import { ConfigRules, type RuleCheck } from './config-rules';

/**
 * Validated settings of `marketing` sponsored listings (S36 G11, G34, G36, AS-77). The click-signing secret is required
 * and never falls back to another secret; an invalid value fails startup naming the key, never the value.
 */
export interface AdsConfig {
  /** Signs click tokens and keys the viewer/address hashes; at least 32 bytes, distinct from every other secret. */
  ads_click_secret: string;
  /** The secret before a rotation (tokens signed with it stay valid for their 30 minutes); optional, at least 32 bytes. */
  ads_click_secret_previous?: string;
  /** More clicks than this per minute from one address are recorded invalid (`ip_burst`). */
  ads_spam_ip_per_minute: number;
  /** More clicks than this per hour on one campaign from one address or viewer are recorded invalid (`repeat_clicker`). */
  ads_spam_repeat_per_hour: number;
  /** Slot name of this worker replica: stable across restarts, distinct between live replicas (Kafka transactional id). */
  ads_aggregator_instance: string;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const secret = (name: string, required: boolean): Key => {
  const schema = joi
    .string()
    .custom((value: string, helpers) =>
      Buffer.byteLength(value) < 32 ? helpers.error('string.min') : value,
    );
  return { name, verify: required ? schema.required() : schema.allow('') };
};

/** A positive integer with a default; `0`, a negative number and a fraction are refused naming the key. */
const threshold = (name: string, fallback: number): Key => ({
  name,
  verify: joi.number().integer().min(1).max(1_000_000).required(),
  postProcess: ((v: unknown) =>
    v === undefined || v === '' ? fallback : Number(v)) as never,
});

/** Every other secret the app configures; the click secrets must differ from each of them (AS-77, S37 follow-up). */
const ADS_DISTINCT_FROM = [
  'jwt_secret',
  'share_link_code_key',
  'share_link_edge_secret',
  'cart_cookie_secret',
  'notification_secret',
  'ledger_cursor_secret',
  'payments_cursor_secret',
  'discussions_cursor_secret',
  'revalidate_secret',
  'api_key_pepper',
];

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

export const adsSecretsRule: RuleCheck = (ctx) => {
  const found: string[] = [];
  for (const key of ['ads_click_secret', 'ads_click_secret_previous']) {
    const value = ctx.get(key);
    if (!isSet(value)) continue;
    for (const other of ADS_DISTINCT_FROM)
      if (ctx.get(other) === value)
        found.push(`${key} must differ from ${other}`);
  }
  if (
    isSet(ctx.get('ads_click_secret_previous')) &&
    ctx.get('ads_click_secret_previous') === ctx.get('ads_click_secret')
  )
    found.push('ads_click_secret_previous must differ from ads_click_secret');
  return found;
};

ConfigRules.register({
  owner: 'ads',
  keys: ['ads_click_secret', 'ads_click_secret_previous', 'jwt_secret'],
  validate: adsSecretsRule,
});

export const adsConfigKeys: Record<keyof AdsConfig, Key> = {
  ads_click_secret: secret('ADS_CLICK_SECRET', true),
  ads_click_secret_previous: secret('ADS_CLICK_SECRET_PREVIOUS', false),
  ads_spam_ip_per_minute: threshold('ADS_SPAM_IP_PER_MINUTE', 20),
  ads_spam_repeat_per_hour: threshold('ADS_SPAM_REPEAT_PER_HOUR', 3),
  ads_aggregator_instance: {
    name: 'ADS_AGGREGATOR_INSTANCE',
    verify: joi
      .string()
      .pattern(/^[A-Za-z0-9._-]{1,64}$/)
      .required(),
  },
};
