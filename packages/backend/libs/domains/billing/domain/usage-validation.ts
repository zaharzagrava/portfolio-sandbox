import type { UsageRecord } from './usage-types';

/**
 * Why a usage message is dead-lettered (S18 FR-018). The four classes are the labels of
 * `usage_events_rejected_total{reason}`; none carries the payload.
 */
export type UsageRejection =
  'invalid_payload' | 'unknown_metric' | 'ts_in_future' | 'too_old';

export class UsageRejected extends Error {
  constructor(readonly reason: UsageRejection) {
    super(reason);
    this.name = 'UsageRejected';
  }
}

export const METRIC_PATTERN = /^(api\.calls|llm\.[a-z][a-z_]{0,31}\.tokens)$/;
export const MAX_QUANTITY = 1_000_000_000;
export const MAX_SUBJECT_LENGTH = 200;
const FUTURE_SKEW_MS = 5 * 60_000;
const LATE_WINDOW_MS = 90 * 86_400_000;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const reject = (reason: UsageRejection): never => {
  throw new UsageRejected(reason);
};

function instantOf(value: unknown): Date {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value))
    return reject('invalid_payload');
  const date = new Date(value);
  // `new Date('2026-02-30T…')` rolls over; compare the calendar date back to refuse an impossible one
  const day = value.slice(0, 10);
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
  const shifted = offset
    ? new Date(
        date.getTime() +
          (offset[1] === '-' ? -1 : 1) *
            (Number(offset[2]) * 60 + Number(offset[3])) *
            60_000,
      )
    : date;
  if (
    Number.isNaN(date.getTime()) ||
    shifted.toISOString().slice(0, 10) !== day
  )
    return reject('invalid_payload');
  return date;
}

function subjectOf(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SUBJECT_LENGTH
  )
    return reject('invalid_payload');
  return value;
}

function metricOf(value: unknown): string {
  if (typeof value !== 'string') return reject('invalid_payload');
  return METRIC_PATTERN.test(value) ? value : reject('unknown_metric');
}

function inWindow(ts: Date, now: Date): Date {
  if (ts.getTime() > now.getTime() + FUTURE_SKEW_MS)
    return reject('ts_in_future');
  if (ts.getTime() < now.getTime() - LATE_WINDOW_MS) return reject('too_old');
  return ts;
}

/** A raw `usage.recorded` message (S18 events.md): the envelope's identity and subject plus the payload fields. */
export interface RawUsageRecord {
  identity: unknown;
  subjectId: unknown;
  metric: unknown;
  quantity: unknown;
  ts: unknown;
}

/**
 * Validates one usage message (FR-018): subject, identity, quantity 1 to 1,000,000,000 (an integer), metric on the
 * allowlist, `ts` an ISO instant within `[now - 90 days, now + 5 minutes]`. Checks run in that order; the first
 * failure names the class. Unknown extra fields are ignored.
 */
export function validateUsageRecord(
  raw: RawUsageRecord,
  now: Date,
): UsageRecord {
  if (typeof raw.identity !== 'string' || raw.identity.length === 0)
    reject('invalid_payload');
  const subjectId = subjectOf(raw.subjectId);
  const quantity = raw.quantity;
  if (
    typeof quantity !== 'number' ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_QUANTITY
  )
    reject('invalid_payload');
  const ts = instantOf(raw.ts);
  const metric = metricOf(raw.metric);
  inWindow(ts, now);
  return {
    identity: raw.identity as string,
    subjectId,
    metric,
    quantity: quantity as number,
    ts,
  };
}

export type LlmCallUsage =
  | { kind: 'record'; record: UsageRecord }
  | { kind: 'ignored'; reason: 'zero_quantity' };

/**
 * Validates an `llm.call_completed` message into usage (FR-022, research R-3): identity `llm:<aggregateId>` (a
 * producer retry with the same call id counts once), the quantity is the billable tokens, a call with none records
 * nothing, and the metric is the one named in the event.
 */
export function validateLlmCall(
  raw: {
    aggregateId: unknown;
    occurredAt: unknown;
    payload: {
      subjectId?: unknown;
      metric?: unknown;
      billableTokens?: unknown;
    };
  },
  now: Date,
): LlmCallUsage {
  if (typeof raw.aggregateId !== 'string' || raw.aggregateId.length === 0)
    reject('invalid_payload');
  const subjectId = subjectOf(raw.payload?.subjectId);
  const tokens = raw.payload?.billableTokens;
  if (
    typeof tokens !== 'number' ||
    !Number.isSafeInteger(tokens) ||
    tokens < 0 ||
    tokens > MAX_QUANTITY
  )
    reject('invalid_payload');
  const ts = instantOf(raw.occurredAt);
  const metric = metricOf(raw.payload?.metric);
  inWindow(ts, now);
  if (tokens === 0) return { kind: 'ignored', reason: 'zero_quantity' };
  return {
    kind: 'record',
    record: {
      identity: `llm:${raw.aggregateId as string}`,
      subjectId,
      metric,
      quantity: tokens as number,
      ts,
    },
  };
}
