/**
 * The rules every collector applies to a client analytics event (S39 FR-001 – FR-009): the backend fallback
 * (`POST /api/events`) and the edge worker (`POST /collect`) import this one file, and `ingest-vectors.json` pins what
 * it decides. It has no imports and uses no runtime API (no zod, no Node, no clock): `now` is always passed in, so
 * both runtimes and the unit specs run the very same function.
 */

/** Closed list of per-event rejection codes; the order is the precedence when an event has several problems. */
export const INGEST_CODES = [
  'invalid_event_id',
  'unknown_event_name',
  'invalid_anonymous_id',
  'invalid_timestamp',
  'invalid_props',
  'invalid_page',
  'invalid_exposure',
  'forbidden_field',
  'event_too_old',
  'duplicate_in_batch',
] as const;
export type IngestCode = (typeof INGEST_CODES)[number];

/** Names a client may send. `purchase` exists in the store but only the server may emit it (FR-002). */
export const INGEST_EVENT_NAMES = [
  'page_view',
  'product_view',
  'search',
  'add_to_cart',
  'checkout_step',
  'exposure',
  'click',
  'video_view',
] as const;
export type IngestEventName = (typeof INGEST_EVENT_NAMES)[number];

export const SERVER_EVENT_NAMES = ['purchase'] as const;

/** Fields the server alone decides; a client that sends one has its event rejected `forbidden_field`. */
export const FORBIDDEN_FIELDS = [
  'user_id',
  'received_at',
  'country',
  'platform',
] as const;

export const INGEST_PLATFORMS = ['web', 'ios', 'android'] as const;

export const INGEST_LIMITS = {
  events: 50,
  bodyBytes: 128 * 1024,
  maxAgeMs: 7 * 86_400_000,
  maxSkewMs: 10 * 60_000,
  props: 30,
  propKey: 64,
  propValue: 500,
  page: 500,
  variant: 32,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANONYMOUS_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PROP_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** `YYYY-MM-DD HH:mm:ss.SSS` in UTC, the ClickHouse DateTime64(3) text form. */
export function formatStoredTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').replace('Z', '');
}

/** An event the rules accepted, with times already in the stored form and every prop flattened to a string. */
export interface AcceptedEvent {
  event_id: string;
  name: IngestEventName;
  anonymous_id: string;
  ts: string;
  received_at: string;
  page: string;
  props: Record<string, string>;
}

/** The message on `analytics.events` (FR-003). */
export interface StoredEventMessage extends AcceptedEvent {
  user_id: string;
  country: string;
  platform: string;
}

export type IngestVerdict =
  | { ok: true; event: AcceptedEvent }
  | { ok: false; code: Exclude<IngestCode, 'duplicate_in_batch'> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const has = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Event time kept as sent, except more than 10 minutes ahead of the receive time, which becomes the receive time. */
export function clampTimestamp(ts: number, now: number): number {
  return ts > now + INGEST_LIMITS.maxSkewMs ? now : ts;
}

/** `props` of an exposure must be exactly `{experiment, variant}` or `{flag_key, variant, flag_version}`, all strings. */
export function isValidExposure(props: unknown): boolean {
  if (!isRecord(props)) return false;
  const keys = Object.keys(props).sort();
  const experiment = keys.join(',') === 'experiment,variant';
  const flag = keys.join(',') === 'flag_key,flag_version,variant';
  if (!experiment && !flag) return false;
  if (!keys.every((key) => typeof props[key] === 'string')) return false;
  const variant = props.variant as string;
  return variant.length >= 1 && variant.length <= INGEST_LIMITS.variant;
}

function flattenProps(props: unknown): Record<string, string> | null {
  if (props === undefined) return {};
  if (!isRecord(props)) return null;
  const keys = Object.keys(props);
  if (keys.length > INGEST_LIMITS.props) return null;
  const flat: Record<string, string> = {};
  for (const key of keys) {
    if (!PROP_KEY.test(key)) return null;
    const value = props[key];
    if (typeof value === 'string') {
      if (value.length > INGEST_LIMITS.propValue) return null;
      flat[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      flat[key] = String(value);
    } else if (typeof value === 'boolean') flat[key] = String(value);
    else return null;
  }
  return flat;
}

/**
 * Judges one client event. One code per event, the first problem in the order of `INGEST_CODES`; `duplicate_in_batch`
 * is a property of the batch and is decided by `validateIngestBatch`.
 */
export function validateIngestEvent(
  raw: unknown,
  { now }: { now: number },
): IngestVerdict {
  const fail = (code: Exclude<IngestCode, 'duplicate_in_batch'>) =>
    ({ ok: false, code }) as const;
  if (!isRecord(raw)) return fail('invalid_event_id');
  if (typeof raw.event_id !== 'string' || !UUID.test(raw.event_id))
    return fail('invalid_event_id');
  if (
    typeof raw.name !== 'string' ||
    !(INGEST_EVENT_NAMES as readonly string[]).includes(raw.name)
  )
    return fail('unknown_event_name');
  if (
    typeof raw.anonymous_id !== 'string' ||
    !ANONYMOUS_ID.test(raw.anonymous_id)
  )
    return fail('invalid_anonymous_id');
  if (
    typeof raw.ts !== 'number' ||
    !Number.isSafeInteger(raw.ts) ||
    raw.ts < 0
  )
    return fail('invalid_timestamp');
  const props = flattenProps(raw.props);
  if (!props) return fail('invalid_props');
  if (
    raw.page !== undefined &&
    (typeof raw.page !== 'string' || raw.page.length > INGEST_LIMITS.page)
  )
    return fail('invalid_page');
  if (raw.name === 'exposure' && !isValidExposure(raw.props))
    return fail('invalid_exposure');
  if (FORBIDDEN_FIELDS.some((field) => has(raw, field)))
    return fail('forbidden_field');
  if (raw.ts < now - INGEST_LIMITS.maxAgeMs) return fail('event_too_old');
  return {
    ok: true,
    event: {
      event_id: raw.event_id.toLowerCase(),
      name: raw.name as IngestEventName,
      anonymous_id: raw.anonymous_id,
      ts: formatStoredTime(clampTimestamp(raw.ts, now)),
      received_at: formatStoredTime(now),
      page: (raw.page as string | undefined) ?? '',
      props,
    },
  };
}

export interface IngestBatchResult {
  accepted: AcceptedEvent[];
  rejected: { index: number; code: IngestCode }[];
}

/** Judges a whole batch: input order kept, a repeated `event_id` collapsed to its first accepted copy. */
export function validateIngestBatch(
  events: readonly unknown[],
  context: { now: number },
): IngestBatchResult {
  const accepted: AcceptedEvent[] = [];
  const rejected: IngestBatchResult['rejected'] = [];
  const seen = new Set<string>();
  events.forEach((raw, index) => {
    const verdict = validateIngestEvent(raw, context);
    if (!verdict.ok) {
      rejected.push({ index, code: verdict.code });
    } else if (seen.has(verdict.event.event_id)) {
      rejected.push({ index, code: 'duplicate_in_batch' });
    } else {
      seen.add(verdict.event.event_id);
      accepted.push(verdict.event);
    }
  });
  return { accepted, rejected };
}

/** `{events: [1..50]}`; anything else is an invalid envelope (`400`). */
export function readEnvelope(body: unknown): unknown[] | null {
  if (!isRecord(body) || !Array.isArray(body.events)) return null;
  const { length } = body.events;
  return length >= 1 && length <= INGEST_LIMITS.events ? body.events : null;
}

const COUNTRY = /^[A-Z]{2}$/;

/** A country the collector may record: two uppercase letters that are not Cloudflare's `XX` (unknown) or `T1` (Tor). */
export function sanitizeCountry(value: string | null | undefined): string {
  return value && COUNTRY.test(value) && value !== 'XX' ? value : '';
}

/** `web`, `ios` or `android`; anything else (including `server`) is `web`. */
export function sanitizePlatform(value: string | null | undefined): string {
  return value && (INGEST_PLATFORMS as readonly string[]).includes(value)
    ? value
    : 'web';
}

/** The stored message: the accepted event plus what the collector knows (never taken from the body). */
export function toStoredMessage(
  event: AcceptedEvent,
  meta: { userId?: string; country?: string; platform?: string },
): StoredEventMessage {
  return {
    ...event,
    user_id: meta.userId ?? '',
    country: sanitizeCountry(meta.country),
    platform: sanitizePlatform(meta.platform),
  };
}
