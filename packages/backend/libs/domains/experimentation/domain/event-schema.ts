import { z } from 'zod';

/**
 * Client analytics event contract (shared by the backend fallback and,
 * mirrored by hand, the edge worker). Unknown names are rejected; props are
 * flat string/number/boolean maps (ClickHouse Map(String, String)).
 */
export const CLIENT_EVENT_NAMES = ['page_view', 'product_view', 'search', 'add_to_cart', 'checkout_step', 'exposure', 'click'] as const;
export const ANALYTICS_TOPIC = 'analytics.events';
const MAX_SKEW_MS = 10 * 60_000;
const MAX_AGE_MS = 7 * 86_400_000;

export const ClientEvent = z.object({
  event_id: z.string().uuid(),
  name: z.enum(CLIENT_EVENT_NAMES),
  anonymous_id: z.string().min(8).max(64),
  ts: z.number().int(),
  page: z.string().max(500).optional(),
  props: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean()])).refine((p) => Object.keys(p).length <= 30, 'max 30 props').optional(),
});
export type ClientEvent = z.infer<typeof ClientEvent>;

export const ClientBatch = z.object({ events: z.array(z.unknown()).min(1).max(50) });

export interface StoredEvent {
  event_id: string;
  name: string;
  anonymous_id: string;
  user_id: string;
  ts: string;
  received_at: string;
  country: string;
  platform: string;
  page: string;
  props: Record<string, string>;
}

const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/**
 * Enrichment + clock sanity: the client's clock is trusted for ORDER (event
 * time) but clamped - events from the future or older than 7 days (a phone
 * that was offline for a month) are pinned to receive time / dropped.
 */
export function toStored(e: ClientEvent, meta: { userId?: string; country?: string; platform?: string }, now = Date.now()): StoredEvent | null {
  if (e.ts < now - MAX_AGE_MS) return null;
  const ts = e.ts > now + MAX_SKEW_MS ? now : e.ts;
  return {
    event_id: e.event_id,
    name: e.name,
    anonymous_id: e.anonymous_id,
    user_id: meta.userId ?? '',
    ts: chTime(ts),
    received_at: chTime(now),
    country: meta.country ?? '',
    platform: meta.platform ?? 'web',
    page: e.page ?? '',
    props: Object.fromEntries(Object.entries(e.props ?? {}).map(([k, v]) => [k, String(v)])),
  };
}
