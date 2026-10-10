import { TRENDING_CATEGORY_PATTERN } from '@marketplace-sandbox/contracts';
import type { StoredAnalyticsEvent } from '@marketplace-sandbox/contracts';

export type CountedName = 'product_view' | 'add_to_cart';

export interface CountedEvent {
  kind: 'count';
  eventId: string;
  /** The `anonymous_id`: used in memory by the caps only, never stored, logged or labelled. */
  visitorId: string;
  name: CountedName;
  productId: string;
  /** A valid catalog slug the event claims, or `null` (counts in `all` only). */
  category: string | null;
  /** A category was present but is not a valid slug (counted as `category_rejected`). */
  categoryRejected: boolean;
  weight: number;
  eventTimeMs: number;
  receivedAtMs: number;
}

export type NormalisedEvent =
  | CountedEvent
  /** Valid but not counted; its times still move the partition's watermark and idle clock. */
  | { kind: 'ignored'; eventTimeMs: number; receivedAtMs: number }
  | { kind: 'invalid'; reason: string };

export interface EventWeights {
  weightView: number;
  weightCart: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED_TIME =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

/** `YYYY-MM-DD HH:mm:ss.SSS` in UTC to epoch milliseconds, or `null` for anything else (including dates that do not exist). */
export function parseStoredTime(value: string): number | null {
  const m = STORED_TIME.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(t);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    back.getUTCHours() !== h ||
    back.getUTCMinutes() !== mi ||
    back.getUTCSeconds() !== s
  )
    return null;
  return t;
}

/**
 * A validated analytics message to what the counter needs (S35 FR-011, FR-012). Only `product_view` and `add_to_cart` with
 * a product id count; the event time is the earlier of `ts` and `received_at`, so a forged future clock cannot move time.
 * Pure: no clock is read.
 */
export function normalise(
  event: StoredAnalyticsEvent,
  weights: EventWeights,
): NormalisedEvent {
  const ts = parseStoredTime(event.ts);
  if (ts === null) return { kind: 'invalid', reason: 'ts is not a valid time' };
  const receivedAt = parseStoredTime(event.received_at);
  if (receivedAt === null)
    return { kind: 'invalid', reason: 'received_at is not a valid time' };
  const times = {
    eventTimeMs: Math.min(ts, receivedAt),
    receivedAtMs: receivedAt,
  };
  if (event.name !== 'product_view' && event.name !== 'add_to_cart')
    return { kind: 'ignored', ...times };
  const productId = event.props.product_id;
  if (productId === undefined || productId === '')
    return { kind: 'ignored', ...times };
  if (!UUID.test(productId))
    return { kind: 'invalid', reason: 'props.product_id is not a UUID' };
  const claimed = event.props.category;
  const valid =
    claimed !== undefined && TRENDING_CATEGORY_PATTERN.test(claimed);
  return {
    kind: 'count',
    eventId: event.event_id,
    visitorId: event.anonymous_id,
    name: event.name,
    productId: productId.toLowerCase(),
    category: valid ? claimed : null,
    categoryRejected: claimed !== undefined && !valid,
    weight:
      event.name === 'product_view' ? weights.weightView : weights.weightCart,
    ...times,
  };
}
