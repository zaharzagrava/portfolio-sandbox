import * as joi from 'joi';
import { ConfigRules, type RuleCheck } from './config-rules';

/**
 * Validated settings of the `developer-platform` public API (S42 G-01, AS-21). The pepper is mixed into every API key
 * hash; it is required, never falls back to another secret, and an invalid value fails startup naming the key.
 */
export interface DeveloperPlatformConfig {
  /** Mixed into API key hashes; at least 32 bytes, distinct from every other secret. */
  api_key_pepper: string;
  /** The pepper before a rotation: keys hashed with it re-hash on their next use; optional, at least 32 bytes. */
  api_key_pepper_previous?: string;
}

type Key = { name: string; verify: joi.AnySchema };

const pepper = (name: string, required: boolean): Key => {
  const schema = joi
    .string()
    .custom((value: string, helpers) =>
      Buffer.byteLength(value) < 32 ? helpers.error('string.min') : value,
    );
  return { name, verify: required ? schema.required() : schema.allow('') };
};

const OTHER_SECRETS = [
  'jwt_secret',
  'share_link_code_key',
  'share_link_edge_secret',
  'cart_cookie_secret',
  'notification_secret',
  'ledger_cursor_secret',
  'payments_cursor_secret',
  'discussions_cursor_secret',
  'revalidate_secret',
  'ads_click_secret',
];

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

export const apiKeyPepperRule: RuleCheck = (ctx) => {
  const found: string[] = [];
  for (const key of ['api_key_pepper', 'api_key_pepper_previous']) {
    const value = ctx.get(key);
    if (!isSet(value)) continue;
    for (const other of OTHER_SECRETS)
      if (ctx.get(other) === value)
        found.push(`${key} must differ from ${other}`);
  }
  if (
    isSet(ctx.get('api_key_pepper_previous')) &&
    ctx.get('api_key_pepper_previous') === ctx.get('api_key_pepper')
  )
    found.push('api_key_pepper_previous must differ from api_key_pepper');
  return found;
};

ConfigRules.register({
  owner: 'developer-platform',
  keys: ['api_key_pepper', 'api_key_pepper_previous', 'jwt_secret'],
  validate: apiKeyPepperRule,
});

export const developerPlatformConfigKeys: Record<
  keyof DeveloperPlatformConfig,
  Key
> = {
  api_key_pepper: pepper('API_KEY_PEPPER', true),
  api_key_pepper_previous: pepper('API_KEY_PEPPER_PREVIOUS', false),
};
