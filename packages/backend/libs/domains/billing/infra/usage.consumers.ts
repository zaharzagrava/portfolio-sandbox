import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { LlmCallCompleted } from '@app/infrastructure/llm';
import {
  PermanentError,
  TransientError,
} from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { clickhouseFailure } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { errorKind } from './clickhouse-usage.store';
import { SubscriptionStatusChanged } from '../application/events/billing-events';
import { UsageRecorded } from '../application/events/usage-events';
import {
  entitlementInvalidationsCounter,
  usageIgnoredCounter,
  usageIngestedCounter,
  usageRejectedCounter,
} from '../domain/metrics';
import {
  ENTITLEMENT_CACHE,
  USAGE_STORE,
  type EntitlementCachePort,
  type UsageStorePort,
} from '../domain/ports';
import type { UsageRecord } from '../domain/usage-types';
import {
  UsageRejected,
  validateLlmCall,
  validateUsageRecord,
} from '../domain/usage-validation';

/**
 * Consumer group and inbox names (specs/domains/S18-usage-entitlements/contracts/events.md). Each consumer keeps its
 * own offsets, lag and dead letters.
 */
export const ENTITLEMENT_INVALIDATION_CONSUMER =
  'billing-entitlement-invalidation';
export const USAGE_RECORDED_CONSUMER = 'billing-usage-recorded';
export const LLM_USAGE_CONSUMER = 'billing-llm-usage';

/**
 * The framework checks a payload against the contract it was handed before the consumer sees it, and dead-letters a
 * failure without a word to the consumer. Usage must count every rejection by its own reason (FR-018), so the usage
 * consumers declare the contract's identity (type, version, topic) with a payload check that only requires an object;
 * the strict check is `domain/usage-validation.ts`, and its verdict is the reason of the dead letter.
 */
const intake = (event: HandledEvent['event']): HandledEvent => ({
  event: { ...event, schema: z.looseObject({}) },
});

/** Reacts to `billing.subscription_status_changed` (S17): drops the cached entitlements of the subject. */
@Injectable()
export class SubscriptionStatusConsumer implements Projector {
  readonly name = ENTITLEMENT_INVALIDATION_CONSUMER;
  readonly topics = [SubscriptionStatusChanged.topic];
  // the runner records (consumer, eventId) in the transaction of the effect and hands over only fresh events
  readonly idempotency: IdempotencyMechanism = 'inbox';
  readonly handles: HandledEvent[] = [{ event: SubscriptionStatusChanged }];

  constructor(
    @Inject(ENTITLEMENT_CACHE) private readonly cache: EntitlementCachePort,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const envelope of events) {
      const p = envelope.payload as {
        subscriptionId: string;
        subjectType: 'USER' | 'SHOP';
        subjectId: string;
        subscriptionVersion: number;
      };
      // a failure to reach the cache store is raised: the message is not acknowledged and is redelivered (FR-014)
      const outcome = await this.cache.invalidateIfOlder(
        p.subjectType,
        p.subjectId,
        p.subscriptionId,
        p.subscriptionVersion,
      );
      entitlementInvalidationsCounter.add(1, { outcome });
      if (outcome === 'applied') counts.applied++;
      else counts.stale++;
    }
    return counts;
  }
}

/** Remembers the ids already counted as rejected, so the runner's retries of one poison message count it once. */
class RejectedOnce {
  private readonly seen = new Set<string>();
  constructor(private readonly capacity = 5_000) {}
  firstTime(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    if (this.seen.size >= this.capacity)
      this.seen.delete(this.seen.values().next().value as string);
    this.seen.add(eventId);
    return true;
  }
}

/** What both usage consumers do after they have turned a message into a record: store the batch durably. */
abstract class UsageIntake implements Projector {
  private readonly rejected = new RejectedOnce();
  protected readonly logger = new Logger(UsageIntake.name);
  abstract readonly name: string;
  abstract readonly topics: string[];
  abstract readonly handles: HandledEvent[];
  readonly idempotency: IdempotencyMechanism = 'inbox';

  constructor(
    protected readonly store: UsageStorePort,
    protected readonly clock: Clock,
  ) {}

  /** Validates one message: the record, `null` for a message that records nothing, or a `PermanentError`. */
  protected abstract record(envelope: EventEnvelope): UsageRecord | null;

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const records: UsageRecord[] = [];
    for (const envelope of events) {
      try {
        const record = this.record(envelope);
        if (record) records.push(record);
      } catch (error) {
        if (!(error instanceof UsageRejected)) throw error;
        if (this.rejected.firstTime(envelope.eventId))
          usageRejectedCounter.add(1, { reason: error.reason });
        throw new PermanentError(error.reason, { cause: error });
      }
    }
    if (records.length > 0) {
      try {
        // durable: resolves once the rows are stored; a failure leaves the messages unacknowledged and redelivered
        await this.store.insert(records, this.clock.now());
      } catch (error) {
        const failure = clickhouseFailure(error);
        this.logger.warn(`usage store write failed (${errorKind(error)})`);
        throw failure instanceof TransientError
          ? failure
          : new TransientError('usage store write failed', { cause: error });
      }
      for (const record of records)
        usageIngestedCounter.add(1, {
          metric_class: record.metric === 'api.calls' ? 'api' : 'llm',
        });
    }
    // a message that recorded nothing (zero tokens) is acknowledged and counted as ignored by the runner's metrics
    return {
      applied: records.length,
      duplicate: 0,
      stale: events.length - records.length,
    };
  }
}

/** `usage.recorded` (public API metering, S42): the identity is the envelope's `eventId` (FR-017). */
@Injectable()
export class UsageRecordedConsumer extends UsageIntake {
  readonly name = USAGE_RECORDED_CONSUMER;
  readonly topics = [UsageRecorded.topic];
  readonly handles = [intake(UsageRecorded)];

  constructor(
    @Inject(USAGE_STORE) store: UsageStorePort,
    @Inject(CLOCK) clock: Clock,
  ) {
    super(store, clock);
  }

  protected record(envelope: EventEnvelope): UsageRecord {
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    return validateUsageRecord(
      {
        identity: envelope.eventId,
        subjectId: envelope.aggregateId,
        metric: payload.metric,
        quantity: payload.quantity,
        ts: payload.ts,
      },
      this.clock.now(),
    );
  }
}

/** `llm.call_completed` (S46, S47): the identity is `llm:<aggregateId>`, the quantity the billable tokens (FR-022). */
@Injectable()
export class LlmUsageConsumer extends UsageIntake {
  readonly name = LLM_USAGE_CONSUMER;
  readonly topics = [LlmCallCompleted.topic];
  readonly handles = [intake(LlmCallCompleted)];

  constructor(
    @Inject(USAGE_STORE) store: UsageStorePort,
    @Inject(CLOCK) clock: Clock,
  ) {
    super(store, clock);
  }

  protected record(envelope: EventEnvelope): UsageRecord | null {
    const result = validateLlmCall(
      {
        aggregateId: envelope.aggregateId,
        occurredAt: envelope.occurredAt,
        payload: (envelope.payload ?? {}) as Record<string, unknown>,
      },
      this.clock.now(),
    );
    if (result.kind === 'ignored') {
      usageIgnoredCounter.add(1, { reason: result.reason });
      return null;
    }
    return result.record;
  }
}
