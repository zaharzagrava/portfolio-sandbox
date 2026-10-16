import * as joi from 'joi';
import { ConfigRules, type RuleCheck } from './config-rules';

/**
 * Settings of the `content` domain (S27 AS-59, FR-034): the preview signing key, the front end's revalidation endpoint
 * and the CDN credentials. The limits (stories per shop, locales, ...) are the domain's own, see `story-config.ts`.
 */
export interface StoriesConfig {
  /** Signs preview tokens only (HS256); never the session key. */
  story_preview_secret?: string;
  /** `<front host>/api/revalidate` is built from `front_host`; this overrides the full URL when set. */
  revalidate_url?: string;
  /** CDN zone and API token used to purge by cache tag; unset outside production selects the logging adapter. */
  cdn_zone?: string;
  cdn_token?: string;
  /** Base URL of the CDN's API; default Cloudflare's. Set to a test double in specs. */
  cdn_api_url?: string;
}

type Key = { name: string; verify: joi.AnySchema };
const optional = (name: string): Key => ({
  name,
  verify: joi.string().optional().allow(''),
});

export const storiesConfigKeys: Record<keyof StoriesConfig, Key> = {
  story_preview_secret: optional('STORY_PREVIEW_SECRET'),
  revalidate_url: optional('REVALIDATE_URL'),
  cdn_zone: optional('CDN_ZONE'),
  cdn_token: optional('CDN_TOKEN'),
  cdn_api_url: optional('CDN_API_URL'),
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/** The keys a production start needs; the message names the key and never a value. */
export const STORY_PRODUCTION_KEYS = [
  'story_preview_secret',
  'revalidate_secret',
  'revalidate_url',
  'cdn_zone',
  'cdn_token',
  'front_host',
  'backend_host',
] as const;

/**
 * S27 AS-59: production refuses to start without the preview secret, the revalidation secret and URL, the CDN
 * credentials and the two host names; the preview secret must be its own secret.
 */
export const storiesProductionRule: RuleCheck = (ctx) => {
  if (!ctx.production) return [];
  const found: string[] = [];
  for (const key of STORY_PRODUCTION_KEYS)
    if (!isSet(ctx.get(key))) found.push(`${key} is required in production`);
  const preview = ctx.get('story_preview_secret');
  if (isSet(preview)) {
    if (String(preview).length < 32)
      found.push('story_preview_secret must be at least 32 characters');
    for (const other of ['jwt_secret', 'revalidate_secret'])
      if (ctx.get(other) === preview)
        found.push(`story_preview_secret must differ from ${other}`);
  }
  return found;
};

ConfigRules.register({
  owner: 'content',
  keys: [...STORY_PRODUCTION_KEYS, 'jwt_secret'],
  validate: storiesProductionRule,
});
