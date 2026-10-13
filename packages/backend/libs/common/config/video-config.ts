import * as joi from 'joi';
import { ConfigRules, RuleCheck } from './config-rules';

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

const urlOf = (value: unknown): URL | undefined => {
  try {
    return isSet(value) ? new URL(String(value)) : undefined;
  } catch {
    return undefined;
  }
};

/** A cookie `Domain` attribute covers the host itself and every subdomain of it (a leading dot is optional). */
export function cookieDomainContains(domain: string, host: string): boolean {
  const d = domain.trim().replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  return d !== '' && (h === d || h.endsWith(`.${d}`));
}

const PEM_PRIVATE_KEY = /-----BEGIN (?:RSA )?PRIVATE KEY-----/;

/**
 * S30 AS-58 / FR-042 / FR-072: in production the media bucket, the video delivery host, the cookie domain, the
 * signing key pair id and the private key are required; the delivery host is https and a different site from the web
 * app and the API; the cookie domain contains both the API host and the delivery host. Outside production signing may
 * stay unset (unlisted playback then answers 503). `media_cdn_url` is not read. Messages name keys, never values.
 */
export const videoProductionRule: RuleCheck = (ctx) => {
  if (!ctx.production) return [];
  const found: string[] = [];
  if (!isSet(ctx.get('media_bucket')))
    found.push('media_bucket is required in production');

  const delivery = urlOf(ctx.get('video_cdn_url'));
  if (!isSet(ctx.get('video_cdn_url')))
    found.push('video_cdn_url is required in production');
  else if (delivery === undefined)
    found.push('video_cdn_url must be a valid URL');
  else {
    if (delivery.protocol !== 'https:')
      found.push('video_cdn_url must use https');
    for (const other of ['front_host', 'backend_host']) {
      const host = urlOf(ctx.get(other))?.hostname;
      // Host equality, not registrable domain: the cookie domain must contain the API host and the delivery host, so
      // those two share a parent by construction.
      if (host !== undefined && host === delivery.hostname.toLowerCase())
        found.push(`video_cdn_url must not be the same host as ${other}`);
    }
  }

  const domain = ctx.get('video_cookie_domain');
  if (!isSet(domain))
    found.push('video_cookie_domain is required in production');
  else {
    const api = urlOf(ctx.get('backend_host'));
    if (
      api !== undefined &&
      !cookieDomainContains(String(domain), api.hostname)
    )
      found.push('video_cookie_domain must contain backend_host');
    if (
      delivery !== undefined &&
      !cookieDomainContains(String(domain), delivery.hostname)
    )
      found.push('video_cookie_domain must contain video_cdn_url');
  }

  if (!isSet(ctx.get('cloudfront_key_pair_id')))
    found.push('cloudfront_key_pair_id is required in production');
  const key = ctx.get('cloudfront_private_key');
  if (!isSet(key))
    found.push('cloudfront_private_key is required in production');
  else if (!PEM_PRIVATE_KEY.test(String(key).replace(/\\n/g, '\n')))
    found.push('cloudfront_private_key must be a PEM private key');
  return found;
};

/** Environment keys of the video settings; all optional here, the production rule above makes them required. */
export const videoConfigKeys = {
  video_cdn_url: {
    verify: joi.string().optional().allow(''),
    name: 'VIDEO_CDN_URL',
  },
  video_cookie_domain: {
    verify: joi.string().optional().allow(''),
    name: 'VIDEO_COOKIE_DOMAIN',
  },
  cloudfront_key_pair_id: {
    verify: joi.string().optional().allow(''),
    name: 'CLOUDFRONT_KEY_PAIR_ID',
  },
  cloudfront_private_key: {
    verify: joi.string().optional().allow(''),
    name: 'CLOUDFRONT_PRIVATE_KEY',
  },
};

ConfigRules.register({
  owner: 'video',
  keys: [
    'media_bucket',
    'video_cdn_url',
    'video_cookie_domain',
    'cloudfront_key_pair_id',
    'cloudfront_private_key',
    'front_host',
    'backend_host',
  ],
  validate: videoProductionRule,
});
