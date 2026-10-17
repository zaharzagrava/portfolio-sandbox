import type { LiveDashboardFrame } from '@marketplace-sandbox/contracts';
import { checkoutConversion } from './conversion';
import type { LiveBucket } from './ports';

export const WINDOW_SECONDS = 60;

/** The frame of second `endSecond` from its 60 buckets (oldest first); pure, so it is the same on every instance. */
export function buildFrame(
  shopId: string,
  endSecond: number,
  buckets: LiveBucket[],
): LiveDashboardFrame {
  const last60s = { checkouts: 0, orders: 0, units: 0, revenueMinor: 0 };
  for (const b of buckets) {
    last60s.checkouts += b.checkouts;
    last60s.orders += b.orders;
    last60s.units += b.units;
    last60s.revenueMinor += b.revenue;
  }
  return {
    shopId,
    at: endSecond,
    windowSeconds: WINDOW_SECONDS,
    last60s,
    ordersPerSecond: buckets.map((b) => b.orders),
    checkoutConversion: checkoutConversion(last60s.checkouts, last60s.orders),
  };
}
