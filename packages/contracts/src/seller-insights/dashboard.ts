import { z } from 'zod';

const count = z.number().int().nonnegative();

/** `GET /shops/:shopId/dashboard/today`: the UTC day's totals and the sparse per-minute series. */
export const dashboardTodaySchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    totals: z
      .object({ orders: count, units: count, revenueMinor: count })
      .strict(),
    series: z.array(
      z
        .object({
          /** ISO-8601 UTC, whole minute */
          minute: z.string(),
          orders: count,
          units: count,
          revenueMinor: count,
        })
        .strict(),
    ),
  })
  .strict();
export type DashboardToday = z.infer<typeof dashboardTodaySchema>;
