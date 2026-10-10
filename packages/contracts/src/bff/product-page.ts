import { z } from 'zod';
import { productPublicSchema } from '../catalog';
import { recommendationsResponseSchema } from '../search/recommendations';
import { trendingResponseSchema } from '../search/trending';
import { shopSummarySchema } from '../tenancy';
import {
  auctionPublicSchema,
  boardPostsPageSchema,
  chatUnreadPageSchema,
  flagsResponseSchema,
  flashSalePublicSchema,
  pickupPageSchema,
  productVideosSchema,
} from './upstream';

/** Closed set of section outcomes (S48 FR-005); also the GraphQL `extensions.code` of a degraded field. */
export const BFF_SECTION_CODES = [
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_NOT_FOUND',
  'UPSTREAM_RATE_LIMITED',
  'UPSTREAM_INVALID',
  'UPSTREAM_OVERLOADED',
  'CIRCUIT_OPEN',
  'BUDGET_EXCEEDED',
] as const;
export const sectionCodeSchema = z.enum(BFF_SECTION_CODES);
export type SectionCode = z.infer<typeof sectionCodeSchema>;

export const BFF_SECTIONS = [
  'product',
  'shop',
  'recommendations',
  'trending',
  'flags',
  'chatUnread',
  'discussions',
  'videos',
  'pickup',
  'flashSale',
  'auction',
] as const;
export const sectionNameSchema = z.enum(BFF_SECTIONS);
export type SectionName = z.infer<typeof sectionNameSchema>;

/** Never a message, URL or upstream body (V.3). */
export const sectionErrorSchema = z
  .object({
    section: sectionNameSchema,
    code: sectionCodeSchema,
    retryable: z.boolean(),
  })
  .strict();
export type SectionError = z.infer<typeof sectionErrorSchema>;

export const productPageResponseSchema = z
  .object({
    product: productPublicSchema,
    shop: shopSummarySchema.nullable(),
    recommendations: recommendationsResponseSchema.nullable(),
    trending: trendingResponseSchema.nullable(),
    flags: flagsResponseSchema.nullable(),
    chatUnread: chatUnreadPageSchema.nullable(),
    discussions: boardPostsPageSchema.nullable(),
    videos: productVideosSchema.nullable(),
    pickup: pickupPageSchema.nullable(),
    flashSale: flashSalePublicSchema.nullable(),
    auction: auctionPublicSchema.nullable(),
    errors: z.array(sectionErrorSchema),
  })
  .strict();
export type ProductPageResponse = z.infer<typeof productPageResponseSchema>;

export const BFF_PAGE_LIMITS = {
  radiusKm: { min: 1, max: 100, default: 10 },
} as const;

const coordinate = (max: number) =>
  z
    .string()
    .regex(/^-?\d{1,3}(\.\d{1,8})?$/, 'must be a decimal number')
    .transform(Number)
    .refine((n) => n >= -max && n <= max, `must be between -${max} and ${max}`);

/** `lat` and `lng` come together; `radiusKm` is 1..100 (default 10). Unknown parameters are rejected. */
export const pageQuerySchema = z
  .object({
    lat: coordinate(90).optional(),
    lng: coordinate(180).optional(),
    radiusKm: z
      .string()
      .regex(/^\d{1,3}$/, 'must be an integer')
      .transform(Number)
      .refine(
        (n) =>
          n >= BFF_PAGE_LIMITS.radiusKm.min &&
          n <= BFF_PAGE_LIMITS.radiusKm.max,
        'must be 1..100',
      )
      .default(BFF_PAGE_LIMITS.radiusKm.default),
  })
  .strict()
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), {
    message: 'lat and lng must be given together',
    path: ['lat'],
  });
export type PageQuery = z.infer<typeof pageQuerySchema>;
