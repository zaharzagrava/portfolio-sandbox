import * as joi from 'joi';
import { ConfigRules, RuleCheck } from './config-rules';

/**
 * Validated settings of notifications (S28 FR-034, contracts/services.md "Configuration"). The line concurrency has a
 * default applied here; the secret and the provider credentials are checked by `notificationsSecretsRule`, which fails
 * startup in production naming the setting (never its value). The unsubscribe signing secret has no fallback to
 * `JWT_SECRET`: it is its own setting and must differ from every other secret.
 */
export interface NotificationsConfig {
  notifications_tx_concurrency: number;
  notifications_marketing_concurrency: number;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const int = (name: string, fallback: number, min = 1, max = 200): Key => ({
  name,
  verify: joi.number().integer().min(min).max(max).required(),
  postProcess: ((v: unknown) =>
    v === undefined ? fallback : Number(v)) as never,
});

export const notificationsConfigKeys: Record<keyof NotificationsConfig, Key> = {
  notifications_tx_concurrency: int('NOTIFICATIONS_TX_CONCURRENCY', 10),
  notifications_marketing_concurrency: int(
    'NOTIFICATIONS_MARKETING_CONCURRENCY',
    3,
  ),
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/** Every other secret the app configures; `notification_secret` must differ from each of them. */
const OTHER_SECRETS = [
  'jwt_secret',
  'cart_cookie_secret',
  'ads_click_secret',
  'share_link_code_key',
  'share_link_edge_secret',
  'ledger_cursor_secret',
  'payments_cursor_secret',
  'revalidate_secret',
  'api_key_pepper',
];

export const notificationsSecretsRule: RuleCheck = (ctx) => {
  const found: string[] = [];
  const secret = ctx.get('notification_secret');
  if (ctx.production && !isSet(secret))
    found.push('notification_secret is required');
  if (isSet(secret)) {
    if (ctx.production && Buffer.byteLength(String(secret)) < 32)
      found.push('notification_secret must be at least 32 bytes');
    for (const other of OTHER_SECRETS)
      if (isSet(ctx.get(other)) && ctx.get(other) === secret)
        found.push(`notification_secret must differ from ${other}`);
  }
  return found;
};

/** In production each channel the catalog uses needs a real provider; the log and memory stand-ins are for development. */
export const notificationsProvidersRule: RuleCheck = (ctx) => {
  if (!ctx.production) return [];
  const found: string[] = [];
  if (ctx.get('email_provider') === 'memory')
    found.push('email_provider=memory is not allowed in production');
  else if (!isSet(ctx.get('ses_from_address')) && !isSet(ctx.get('smtp_url')))
    found.push('an e-mail provider is required: ses_from_address or smtp_url');
  for (const key of ['twilio_account_sid', 'twilio_auth_token', 'twilio_from'])
    if (!isSet(ctx.get(key))) found.push(`${key} is required (sms channel)`);
  for (const key of ['firebase_client_email', 'firebase_private_key'])
    if (!isSet(ctx.get(key))) found.push(`${key} is required (push channel)`);
  return found;
};

ConfigRules.register({
  owner: 'notifications',
  keys: [
    'notification_secret',
    'email_provider',
    'ses_from_address',
    'smtp_url',
    'twilio_account_sid',
    'twilio_auth_token',
    'twilio_from',
    'firebase_client_email',
    'firebase_private_key',
    ...OTHER_SECRETS,
  ],
  validate: [notificationsSecretsRule, notificationsProvidersRule],
});
