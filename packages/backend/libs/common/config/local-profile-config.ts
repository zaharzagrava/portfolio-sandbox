import * as joi from 'joi';
import { ConfigRules, type RuleCheck } from './config-rules';

/**
 * Settings that exist only for the local profile (J02, FR-023): a platform administrator provisioned at start-up, a
 * rate-limit allow-list for the journey's address, and the hosts a test receiver may be registered on. Every one of them
 * is refused when `NODE_ENV=production` (the app does not boot), so none can reach a real deployment.
 */
export interface LocalProfileConfig {
  bootstrap_admin_email?: string;
  bootstrap_admin_password?: string;
  rate_limit_allow_ips?: string;
  allowed_receiver_hosts?: string;
  allowed_receiver_ca_fingerprint?: string;
  allowed_provider_hosts?: string;
}

const optional = (name: string, verify: joi.AnySchema = joi.string()) => ({
  name,
  verify: verify.optional().allow(''),
});

export const localProfileConfigKeys = {
  bootstrap_admin_email: optional(
    'BOOTSTRAP_ADMIN_EMAIL',
    joi.string().email({ tlds: { allow: false } }), // a local address such as admin@marketplace.local
  ),
  bootstrap_admin_password: optional(
    'BOOTSTRAP_ADMIN_PASSWORD',
    joi.string().min(12).max(128),
  ),
  /** Comma-separated client IPs that skip every rate-limit policy (many accounts from one test machine). */
  rate_limit_allow_ips: optional('RATE_LIMIT_ALLOW_IPS'),
  /** Comma-separated `host:port` a webhook endpoint may point at although the address is private. */
  allowed_receiver_hosts: optional('ALLOWED_RECEIVER_HOSTS'),
  /**
   * Optional pin: hex SHA-256 fingerprints of the self-signed certificates the listed receivers present, comma-separated.
   * Without it a listed host is trusted with whatever certificate it presents (still HTTPS, never plain HTTP).
   */
  allowed_receiver_ca_fingerprint: optional('ALLOWED_RECEIVER_CA_FINGERPRINT'),
  /**
   * J04: comma-separated `host:port` of a commerce-provider stand-in (the Shopify double) the catalog-sync call stack may
   * reach over HTTPS although the address is private. Every other host stays behind the SSRF guard.
   */
  allowed_provider_hosts: optional('ALLOWED_PROVIDER_HOSTS'),
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

export const parseList = (value: unknown): string[] =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/** The two bootstrap settings come as a pair; and none of the local-profile settings is allowed in production. */
export const localProfileRule: RuleCheck = (ctx) => {
  const problems: string[] = [];
  const email = ctx.get('bootstrap_admin_email');
  const password = ctx.get('bootstrap_admin_password');
  if (isSet(email) !== isSet(password))
    problems.push(
      'bootstrap_admin_email and bootstrap_admin_password must be set together',
    );
  if (ctx.production)
    for (const key of Object.keys(localProfileConfigKeys))
      if (isSet(ctx.get(key)))
        problems.push(`${key} must not be set in production`);
  const hosts = parseList(ctx.get('allowed_receiver_hosts'));
  for (const host of hosts)
    if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(host))
      problems.push('allowed_receiver_hosts entries must be host:port');
  for (const host of parseList(ctx.get('allowed_provider_hosts')))
    if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(host))
      problems.push('allowed_provider_hosts entries must be host:port');
  for (const fingerprint of parseList(
    ctx.get('allowed_receiver_ca_fingerprint'),
  ))
    if (!/^[0-9a-f]{64}$/i.test(fingerprint))
      problems.push(
        'allowed_receiver_ca_fingerprint entries must be hex SHA-256 digests',
      );
  return problems;
};

ConfigRules.register({
  owner: 'local-profile',
  keys: Object.keys(localProfileConfigKeys),
  validate: localProfileRule,
});
