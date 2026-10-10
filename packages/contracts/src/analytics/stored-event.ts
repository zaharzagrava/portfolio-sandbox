import { z } from 'zod';

/** `YYYY-MM-DD HH:mm:ss.SSS` in UTC, the ClickHouse DateTime64(3) text form S39 writes. */
export const STORED_EVENT_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

export const ANALYTICS_EVENT_NAMES = [
  'page_view',
  'product_view',
  'search',
  'add_to_cart',
  'checkout_step',
  'exposure',
  'click',
] as const;

/**
 * The analytics message as S39 publishes it on `analytics.events` (key `anonymous_id`). Consumers validate every message
 * against it before acting. Extra keys (country, platform, page) are tolerated.
 */
export const storedAnalyticsEventSchema = z.object({
  event_id: z.string().uuid(),
  name: z.enum(ANALYTICS_EVENT_NAMES),
  anonymous_id: z.string().min(8).max(64),
  user_id: z.string(),
  ts: z.string().regex(STORED_EVENT_TIME),
  received_at: z.string().regex(STORED_EVENT_TIME),
  props: z.record(z.string(), z.string()),
});
export type StoredAnalyticsEvent = z.infer<typeof storedAnalyticsEventSchema>;
