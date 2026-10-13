import { ConfigRules, RuleCheck } from './config-rules';

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

const hostOf = (value: unknown): string | undefined => {
  try {
    return isSet(value) ? new URL(String(value)).hostname : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Registrable domain, approximated by the last two labels (three when the second-level label is a short public
 * suffix such as `co.uk`). Enough to tell `media.shop.example` from `shop.example`; IP literals compare whole.
 */
export function siteOf(hostname: string): string {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return hostname;
  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  const second = labels[labels.length - 2];
  const tld = labels[labels.length - 1];
  const keep = second.length <= 3 && tld.length === 2 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/**
 * S29 AS-58 / FR-091: in production the media origin, the bucket and the scanner address are required; the origin
 * must be a different site from the web app and the API (user content must not share their cookies); the scanner can
 * only be switched off outside production. Messages name keys, never values.
 */
export const mediaProductionRule: RuleCheck = (ctx) => {
  if (!ctx.production) return [];
  const found: string[] = [];
  if (!isSet(ctx.get('media_cdn_url')))
    found.push('media_cdn_url is required in production');
  else {
    const origin = hostOf(ctx.get('media_cdn_url'));
    if (origin === undefined) found.push('media_cdn_url must be a valid URL');
    else {
      for (const other of ['front_host', 'backend_host']) {
        const host = hostOf(ctx.get(other));
        if (host !== undefined && siteOf(host) === siteOf(origin))
          found.push(`media_cdn_url must be a different site from ${other}`);
      }
    }
  }
  if (!isSet(ctx.get('media_bucket')))
    found.push('media_bucket is required in production');
  if (!isSet(ctx.get('clamav_host')))
    found.push(
      'clamav_host (malware scanner address) is required in production',
    );
  if (ctx.get('media_scanner_disabled') === true)
    found.push('media_scanner_disabled is not allowed in production');
  return found;
};

ConfigRules.register({
  owner: 'media',
  keys: [
    'media_cdn_url',
    'media_bucket',
    'clamav_host',
    'media_scanner_disabled',
    'front_host',
    'backend_host',
  ],
  validate: mediaProductionRule,
});
