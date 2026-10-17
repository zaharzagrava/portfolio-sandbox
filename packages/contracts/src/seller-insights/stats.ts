import { z } from 'zod';

const count = z.number().int().nonnegative();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `GET /shops/:shopId/stats?days=`: a shop's sales summary over the last N UTC days. No buyer identity. */
export const sellerStatsSchema = z
  .object({
    shopId: z.string().uuid(),
    days: z.number().int().min(1).max(365),
    from: day,
    to: day,
    currency: z.string(),
    summary: z
      .object({
        revenueMinor: count,
        orders: count,
        unitsSold: count,
        uniqueBuyers: count,
        refundsCount: count,
        refundedMinor: count,
        netRevenueMinor: z.number().int(),
        avgOrderValueMinor: count,
      })
      .strict(),
    daily: z.array(
      z
        .object({
          day,
          revenueMinor: count,
          orders: count,
          refundedMinor: count,
        })
        .strict(),
    ),
    topProducts: z
      .array(
        z
          .object({
            productId: z.string(),
            title: z.string(),
            revenueMinor: count,
            unitsSold: count,
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export type SellerStats = z.infer<typeof sellerStatsSchema>;
