import { createHash } from 'node:crypto';

export interface UsageRecord {
  requestId: string;
  shopId: string;
  livemode: boolean;
  status: number;
  /** Rate-limit cost of the request (batch = operations, bulk = ceil(items / 100)). */
  cost: number;
  ts: Date;
}

export const USAGE_METRIC = 'api.calls';

export function bucketMinute(ts: Date): Date {
  return new Date(Math.floor(ts.getTime() / 60_000) * 60_000);
}

/** Billable = served live calls with status below 500 and not 429 and not a failed authentication; cost weighted (FR-058). */
export function billableUnits(r: UsageRecord): number {
  if (!r.livemode) return 0;
  if (r.status >= 500 || r.status === 429 || r.status === 401) return 0;
  return Math.max(1, Math.trunc(r.cost));
}

/** UUID-shaped, deterministic per `(shop, metric, minute, sequence)`: a re-emission after a crash dedupes downstream. */
export function usageEventId(
  shopId: string,
  metric: string,
  minute: Date,
  sequence: number,
): string {
  const h = createHash('sha256')
    .update(`${shopId}|${metric}|${minute.toISOString()}|${sequence}`)
    .digest('hex');
  const v = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, '0');
  // version 7 shape, as the event envelope requires
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${v}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}
