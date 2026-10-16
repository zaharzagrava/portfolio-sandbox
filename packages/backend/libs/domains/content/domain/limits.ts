import { z } from 'zod';

/**
 * The numbers of S27 an operator may change (spec Assumptions). Resolved once at start, so a bad value fails the boot
 * naming every broken key, never a value. Defaults are the spec's limits.
 */
export const STORY_DEFAULTS = {
  maxStoriesPerShop: 5_000,
  maxLocales: 20,
  maxBlocks: 200,
  maxDraftBytes: 256 * 1024,
  maxBodyBytes: 1024 * 1024,
  scheduleHorizonDays: 365,
  sitemapPageCapacity: 2_500,
  previewTtlMinutes: 30,
  /** Dead-letter after this many failed deliveries of an invalidation event. */
  invalidationAttempts: 8,
  /** How long the origin read model may keep an entry. */
  readModelTtlSeconds: 60,
  /** Timeout of one call to S05, S03 and the cache (ms). */
  dependencyTimeoutMs: 2_000,
  /** Timeout of one call to the CDN's API and to the front end's revalidation route (ms). */
  cdnTimeoutMs: 5_000,
  /** Statement timeout of one durable read of the public path and of one sitemap batch (ms). */
  readTimeoutMs: 10_000,
} as const;

/** Plain numbers; the object is built once at start and the specs move single values on it. */
export type StoryConfig = {
  -readonly [K in keyof typeof STORY_DEFAULTS]: number;
};

/** Not configurable: protocol and design constants. */
export const LIMITS = {
  maxTitleLength: 200,
  maxRichTextLength: 20_000,
  listDefault: 20,
  listMax: 100,
  sitemapBatch: 1_000,
  /** Batches buffered ahead of a slow client. */
  sitemapBuffered: 2,
  maxUrlsPerSitemapFile: 50_000,
  purgeBatch: 500,
  idempotencyTtlSec: 24 * 3600,
  negativeTtlSec: 10,
  edgeTtlSec: 300,
  staleWhileRevalidateSec: 86_400,
  sitemapTtlSec: 3_600,
  /** Maximum tags per CDN and revalidation call. */
  tagsPerCall: 30,
  /** In-call CDN retries. */
  cdnRetries: 3,
  /** Revalidation signatures older than this are refused by receivers. */
  signatureMaxAgeSeconds: 300,
} as const;

const positiveInt = z.number().int().min(1);
const schema = z.object({
  stories_max_per_shop: positiveInt,
  stories_max_locales: positiveInt,
  stories_max_blocks: positiveInt,
  stories_max_draft_bytes: positiveInt,
  stories_schedule_horizon_days: positiveInt,
  stories_sitemap_page_capacity: positiveInt,
  stories_preview_ttl_minutes: positiveInt,
});

const KEYS = {
  stories_max_per_shop: 'maxStoriesPerShop',
  stories_max_locales: 'maxLocales',
  stories_max_blocks: 'maxBlocks',
  stories_max_draft_bytes: 'maxDraftBytes',
  stories_schedule_horizon_days: 'scheduleHorizonDays',
  stories_sitemap_page_capacity: 'sitemapPageCapacity',
  stories_preview_ttl_minutes: 'previewTtlMinutes',
} as const satisfies Record<keyof z.input<typeof schema>, keyof StoryConfig>;

export type StoryConfigKey = keyof typeof KEYS;
export const STORY_CONFIG_KEYS = Object.keys(KEYS) as StoryConfigKey[];

const asNumber = (value: unknown) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export function resolveStoryConfig(
  raw: Record<string, unknown> = {},
): StoryConfig {
  const candidate = Object.fromEntries(
    STORY_CONFIG_KEYS.map((key) => {
      const value = raw[key];
      return [
        key,
        value === undefined || value === null
          ? STORY_DEFAULTS[KEYS[key]]
          : asNumber(value),
      ];
    }),
  );
  const parsed = schema.safeParse(candidate);
  if (!parsed.success)
    throw new Error(
      `Invalid stories configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || 'config'} ${i.message}`)
        .join('; ')}`,
    );
  const out: StoryConfig = { ...STORY_DEFAULTS };
  for (const key of STORY_CONFIG_KEYS)
    (out as Record<string, number>)[KEYS[key]] = parsed.data[key];
  return out;
}
