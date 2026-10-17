import { z } from 'zod';
import { dashboardTodaySchema } from '../seller-insights/dashboard.ts';
import { shopRankSchema } from '../seller-insights/rank.ts';
import { sellerStatsSchema } from '../seller-insights/stats.ts';
import { shopSchema } from '../tenancy/index.ts';

/** W04 B-2 `GET /bff/seller/:shopId/overview?days=7|30|90`: the shop plus three optional sections. */
export const sellerOverviewErrorSchema = z
  .object({
    section: z.enum(['stats', 'today', 'rank']),
    code: z.string(),
    retryable: z.boolean(),
  })
  .strict();
export type SellerOverviewError = z.infer<typeof sellerOverviewErrorSchema>;

export const sellerOverviewResponseSchema = z
  .object({
    shop: shopSchema,
    stats: sellerStatsSchema.nullable(),
    today: dashboardTodaySchema.nullable(),
    rank: z
      .union([
        shopRankSchema,
        z.object({ notRanked: z.literal(true) }).strict(),
      ])
      .nullable(),
    errors: z.array(sellerOverviewErrorSchema),
  })
  .strict();
export type SellerOverviewResponse = z.infer<
  typeof sellerOverviewResponseSchema
>;
