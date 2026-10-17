import { z } from 'zod';

/**
 * S41 competitor monitor: request and response schemas of the four `/shops/:shopId/competitors` routes
 * (specs/domains/S41-competitor-monitor/contracts/api.md). Request objects are strict: an unknown or repeated field is
 * a `400 validation_failed`.
 */
const uuid = z.string().uuid();
const instant = z.iso.datetime({ offset: true });
const minor = z.number().int().nonnegative();

export const COMPETITOR_URL_MAX_LENGTH = 2048;
export const COMPETITOR_PRICE_POINTS_MAX = 1000;

export const COMPETITOR_ERROR_CODES = [
  'validation_failed',
  'url_not_allowed',
  'url_unresolvable',
  'product_not_found',
  'product_archived',
  'watch_limit_reached',
  'watch_not_found',
  'shop_not_found',
  'permission_denied',
  'shop_suspended',
  'shop_offboarding',
  'rate_limited',
  'history_unavailable',
  'entitlements_unavailable',
  'service_unavailable',
  // what the platform's limiter answers when its store is down on a fail-closed route (S50)
  'rate_limiter_unavailable',
] as const;
export type CompetitorErrorCode = (typeof COMPETITOR_ERROR_CODES)[number];

export const createCompetitorWatchSchema = z
  .object({
    productId: uuid,
    url: z.string().min(1).max(COMPETITOR_URL_MAX_LENGTH),
  })
  .strict();
export type CreateCompetitorWatch = z.infer<typeof createCompetitorWatchSchema>;

export const competitorWatchStatusSchema = z.enum(['ACTIVE', 'PAUSED']);

/** A shop's watch. No target id and no other watcher of the shared target is ever shown (FR-035). */
export const competitorWatchSchema = z
  .object({
    id: uuid,
    productId: uuid,
    url: z.string(),
    host: z.string(),
    status: competitorWatchStatusSchema,
    lastPriceMinor: z.number().int().nonnegative().nullable(),
    currency: z.string().nullable(),
    lastCheckedAt: instant.nullable(),
    lastStatus: z.string().nullable(),
    nextCheckAt: instant,
    createdAt: instant,
  })
  .strict();
export type CompetitorWatch = z.infer<typeof competitorWatchSchema>;

export const competitorWatchListSchema = z
  .object({
    items: z.array(competitorWatchSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type CompetitorWatchList = z.infer<typeof competitorWatchListSchema>;

export const competitorWatchListQuerySchema = z
  .object({
    productId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type CompetitorWatchListQuery = z.infer<
  typeof competitorWatchListQuerySchema
>;

export const competitorPricesQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(365).default(30),
  })
  .strict();
export type CompetitorPricesQuery = z.infer<typeof competitorPricesQuerySchema>;

export const competitorPricesSchema = z
  .object({
    watchId: uuid,
    currency: z.string().nullable(),
    from: instant,
    to: instant,
    points: z
      .array(z.object({ observedAt: instant, priceMinor: minor }).strict())
      .max(COMPETITOR_PRICE_POINTS_MAX),
    lowestMinor: minor.nullable(),
    lowestAt: instant.nullable(),
    latestMinor: minor.nullable(),
  })
  .strict();
export type CompetitorPrices = z.infer<typeof competitorPricesSchema>;
