import { z } from 'zod';
import { boardPeriodSchema } from './leaderboard.ts';

/** `GET /shops/:shopId/rank`: the shop's own position and revenue (members only). */
export const shopRankSchema = z
  .object({
    period: boardPeriodSchema,
    category: z.string().nullable(),
    rank: z.number().int().positive(),
    of: z.number().int().positive(),
    topPercent: z.number().int().min(1).max(100),
    revenueMinor: z.number().int().nonnegative(),
  })
  .strict();
export type ShopRank = z.infer<typeof shopRankSchema>;
