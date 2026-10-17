import { z } from 'zod';

const count = z.number().int().nonnegative();

/** Realtime topic `shop:{shopId}:live`, event `dashboard`, one frame per second per watched shop, no replay. */
export const liveDashboardFrameSchema = z
  .object({
    shopId: z.string(),
    /** epoch seconds of the frame's own second */
    at: z.number().int(),
    windowSeconds: z.literal(60),
    last60s: z
      .object({
        checkouts: count,
        orders: count,
        units: count,
        revenueMinor: count,
      })
      .strict(),
    ordersPerSecond: z.array(count).length(60),
    checkoutConversion: z.number().nullable(),
  })
  .strict();
export type LiveDashboardFrame = z.infer<typeof liveDashboardFrameSchema>;
