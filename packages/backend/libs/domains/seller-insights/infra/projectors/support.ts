import { Logger } from '@nestjs/common';
import { z, type ZodType } from 'zod';
import type { EventDefinition } from '@app/infrastructure/events/define-event';
import type { HandledEvent } from '@app/infrastructure/projections/projector';
import {
  sellerInsightsOrderPaidSchema,
  type SellerInsightsOrderPaid,
} from '@marketplace-sandbox/contracts';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  PermanentError,
  TransientError,
} from '@app/infrastructure/projections/errors';
import { insightsLog, traceIdOf } from '../../application/insights-log';
import { insightsMetrics } from '../../application/seller-insights.metrics';
import {
  AnalyticsStoreUnavailableError,
  BoardStoreUnavailableError,
  type DeadLetterReason,
} from '../../domain/errors';

/** The platform currency; an order in another currency is dead-lettered, never summed (S40 Assumptions). */
export const PLATFORM_CURRENCY = 'EUR';

/**
 * A message that can never be applied: the framework dead-letters it after its attempt budget. The error's name is the
 * reason code, because the dead-letter record carries the error class and nothing else.
 */
export class InsightsDeadLetter extends PermanentError {
  constructor(readonly reason: DeadLetterReason) {
    super(reason);
    this.name = reason;
  }
}

const LOOSE = z.looseObject({});

/**
 * Hands every payload of the event's version to the consumer: the consumer validates it against the contracts schema
 * itself, so a malformed message gets one reason code and one rejection count in one place (S40 FR-007). Unknown types
 * and envelope versions stay the framework's business.
 */
export const permissive = (
  event: EventDefinition<string, string, any>,
): HandledEvent => ({ event: { ...event, schema: LOOSE } });

const counted = new Set<string>();
/**
 * The framework tries a failing chunk, then each event alone, up to the attempt budget; a rejection is counted once per
 * message however often it is tried.
 */
function firstSight(eventId: string, feed: string): boolean {
  const key = `${feed}:${eventId}`;
  if (counted.has(key)) return false;
  if (counted.size >= 10_000) counted.clear();
  counted.add(key);
  return true;
}

const logger = new Logger('SellerInsights');

/** Counts and logs a rejection once per message, then throws the dead-letter error. */
export function reject(
  feed: string,
  event: EventEnvelope,
  reason: DeadLetterReason,
): never {
  if (firstSight(event.eventId, feed)) {
    insightsMetrics.deadLetter(feed, reason);
    if (feed === 'boards') insightsMetrics.board('rejected');
    insightsLog(
      logger,
      'warn',
      'message_dead_lettered',
      { traceId: traceIdOf(event.traceparent) ?? event.eventId },
      { feed, reason, type: event.type },
    );
  }
  throw new InsightsDeadLetter(reason);
}

/** Validates a payload against the consumer schema; anything else is `invalid_payload`. */
export function parseOrReject<T>(
  feed: string,
  event: EventEnvelope,
  schema: ZodType<T>,
): T {
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) return reject(feed, event, 'invalid_payload');
  return parsed.data;
}

/** A paid order the consumer can use: contract-valid and in the platform currency. */
export function parsePaid(
  feed: string,
  event: EventEnvelope,
): SellerInsightsOrderPaid {
  const order = parseOrReject(feed, event, sellerInsightsOrderPaidSchema);
  if (order.currency !== PLATFORM_CURRENCY)
    return reject(feed, event, 'unsupported_currency');
  return order;
}

/** A store failure is the store being unwell: the framework pauses the partition and retries, never dead-letters. */
export async function storeCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (
      error instanceof BoardStoreUnavailableError ||
      error instanceof AnalyticsStoreUnavailableError
    )
      throw new TransientError(error.message, { cause: error });
    throw error;
  }
}

/** Seconds the oldest event of a batch has waited since it happened. */
export function batchLagSeconds(
  events: EventEnvelope[],
  nowMs: number,
): number {
  let oldest = nowMs;
  for (const e of events) oldest = Math.min(oldest, Date.parse(e.occurredAt));
  return Math.max(0, Math.round((nowMs - oldest) / 1000));
}
