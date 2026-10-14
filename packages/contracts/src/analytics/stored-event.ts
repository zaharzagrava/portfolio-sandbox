import { z } from 'zod';
import { INGEST_EVENT_NAMES, SERVER_EVENT_NAMES } from './ingest-rules.ts';

/** `YYYY-MM-DD HH:mm:ss.SSS` in UTC, the ClickHouse DateTime64(3) text form S39 writes. */
export const STORED_EVENT_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

/**
 * Every name that can be stored: the client names (one list, `ingest-rules.ts`) plus the server-only `purchase`, which
 * never travels on the topic (the purchase projector writes it straight into the store).
 */
export const ANALYTICS_EVENT_NAMES = [
  ...INGEST_EVENT_NAMES,
  ...SERVER_EVENT_NAMES,
] as const;

/**
 * The analytics message as S39 publishes it on `analytics.events` (key `anonymous_id`). Consumers validate every message
 * against it before acting. `anonymous_id` is 8 to 64 characters, except `""` on a server-originated `purchase`.
 */
export const storedAnalyticsEventSchema = z
  .object({
    event_id: z.string().uuid(),
    name: z.enum(ANALYTICS_EVENT_NAMES),
    anonymous_id: z.string().max(64),
    user_id: z.string(),
    ts: z.string().regex(STORED_EVENT_TIME),
    received_at: z.string().regex(STORED_EVENT_TIME),
    country: z.string().max(2).optional(),
    platform: z.string().optional(),
    page: z.string().max(500).optional(),
    props: z.record(z.string(), z.string()),
  })
  .refine(
    (event) =>
      event.name === 'purchase'
        ? event.anonymous_id === '' ||
          (event.anonymous_id.length >= 8 && event.anonymous_id.length <= 64)
        : event.anonymous_id.length >= 8,
    { message: 'anonymous_id must be 8-64 characters (empty only for purchase)', path: ['anonymous_id'] },
  );
export type StoredAnalyticsEvent = z.infer<typeof storedAnalyticsEventSchema>;
