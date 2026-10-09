import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { envelopeMessage } from '@app/infrastructure/events/envelope-message';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { classifyPublishError } from './error-classification';
import { relayBackoffMs } from './relay-backoff';
import { RELAY_RANDOM, type RelayRandom } from './relay-random';

const publishedTotal = MetricsRegistry.counter({
  name: 'outbox_published_total',
  help: 'Outbox rows sent to their topic or queue and marked published',
  labels: ['topic'],
});
const publishFailures = MetricsRegistry.counter({
  name: 'outbox_publish_failures_total',
  help: 'Failed sends of an outbox row, by reason (RETRYABLE, NON_RETRYABLE, MAX_ATTEMPTS)',
  labels: ['topic', 'reason'],
});
const pendingGauge = MetricsRegistry.gauge({
  name: 'outbox_pending',
  help: 'Outbox rows waiting to be sent',
  labels: [],
});
const oldestPendingAge = MetricsRegistry.gauge({
  name: 'outbox_oldest_pending_age_seconds',
  help: 'Age of the oldest pending outbox row (0 when none)',
  labels: [],
});
const parkedGauge = MetricsRegistry.gauge({
  name: 'outbox_parked',
  help: 'Outbox rows parked after exhausting their attempts or a non-retryable rejection',
  labels: [],
});

export const OUTBOX_PUBLISHER_OPTIONS = Symbol('OUTBOX_PUBLISHER_OPTIONS');
export interface OutboxPublisherOptions {
  /** Start the local ticker at application bootstrap (default true). Specs drive `drain()` themselves. */
  ticker?: boolean;
}

/** What a task row holds until it is sent (`taskRow`); cleared to `{}` afterwards. */
interface TaskPayload {
  body: unknown;
  groupId?: string;
  delaySeconds?: number;
  traceparent?: string;
}

export interface ClaimedRow {
  id: string;
  kind: 'event' | 'task';
  topic: string;
  aggregateId: string;
  attempts: number;
  payload: EventEnvelope | TaskPayload;
}

export interface DrainResult {
  claimed: number;
  published: number;
  /** Rows whose publish failed and were scheduled for retry (or parked). */
  failed: number;
  /** Rows released untouched because an earlier row of their aggregate failed in this drain. */
  held: number;
  parked: number;
}

/** A group is the unit of one produce request: the rows of one aggregate on one topic, in append order. */
interface Group {
  kind: 'event' | 'task';
  topic: string;
  aggregateId: string;
  rows: ClaimedRow[];
}

/**
 * The poller relay (S53 FR-013 to FR-019): claims due rows under a lease, publishes each envelope unwrapped with its
 * headers, marks them published. At least once: a crash between send and mark republishes after the lease. Rows of an
 * aggregate go out in order and an earlier pending row holds the later ones back. No network I/O inside a
 * transaction: the claim is one committed statement, the send happens after it, the mark after the send.
 */
@Injectable()
export class OutboxPublisherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxPublisherService.name);
  /** The process-wide owner of the ticker: "exactly one poller runs per process". */
  private static tickerOwner?: OutboxPublisherService;
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly producer: KafkaProducerService,
    private readonly config: ApiConfigService,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
    @Optional()
    @Inject(RELAY_RANDOM)
    private readonly random: RelayRandom = Math.random,
    @Optional()
    @Inject(OUTBOX_PUBLISHER_OPTIONS)
    private readonly options: OutboxPublisherOptions = {},
    @Optional() private readonly tasks?: TaskQueue,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.ticker === false) return;
    this.startTicker();
  }

  onModuleDestroy(): void {
    this.stopTicker();
  }

  isTicking(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Starts the local ticker (every `outbox_relay_interval_ms`). Returns false when nothing was started: relay mode
   * `cdc` (Debezium streams the outbox, a poller would double-publish), or a ticker already runs in this process.
   */
  startTicker(): boolean {
    if (this.config.get('outbox_relay') !== 'poller') {
      this.logger.log(
        'outbox_relay=cdc: poller disabled, Debezium relays the outbox',
      );
      return false;
    }
    if (this.timer || OutboxPublisherService.tickerOwner) return false;
    OutboxPublisherService.tickerOwner = this;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.get('outbox_relay_interval_ms'));
    this.timer.unref();
    return true;
  }

  stopTicker(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (OutboxPublisherService.tickerOwner === this)
      OutboxPublisherService.tickerOwner = undefined;
  }

  private async tick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drain();
    } catch (error) {
      this.logger.error(`outbox drain failed: ${(error as Error).name}`);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Claims due rows: pending, due, lease expired, oldest first, skipping rows another relay holds. A candidate is
   * eligible only if no earlier pending row of its aggregate is outside the candidate set (not due, leased by
   * someone else, behind the batch limit): that row holds it back. Parked and published rows never hold anything.
   * One statement, committed before anything is published.
   */
  async claim(): Promise<ClaimedRow[]> {
    const now = this.clock.now();
    const leaseEnd = new Date(
      now.getTime() + this.config.get('outbox_relay_lease_ms'),
    );
    const [rows] = await this.sequelize.query(
      `WITH candidates AS (
         SELECT "id", "aggregateId" FROM "Outbox"
         WHERE "status" = 'pending'
           AND "nextAttemptAt" <= $1 AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)
         ORDER BY "id" LIMIT $3
         FOR UPDATE SKIP LOCKED
       ), eligible AS (
         SELECT c."id" FROM candidates c
         WHERE NOT EXISTS (
           SELECT 1 FROM "Outbox" e
           WHERE e."aggregateId" = c."aggregateId" AND e."status" = 'pending' AND e."id" < c."id"
             AND e."id" NOT IN (SELECT "id" FROM candidates)
         )
       )
       UPDATE "Outbox" o SET "leaseUntil" = $2
       FROM eligible WHERE o."id" = eligible."id"
       RETURNING o."id", o."kind", o."topic", o."aggregateId", o."attempts", o."payload"`,
      { bind: [now, leaseEnd, this.config.get('outbox_relay_batch')] },
    );
    return (rows as ClaimedRow[]).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async drain(): Promise<DrainResult> {
    const result: DrainResult = {
      claimed: 0,
      published: 0,
      failed: 0,
      held: 0,
      parked: 0,
    };
    const rows = await this.claim();
    result.claimed = rows.length;

    const groups = new Map<string, Group>();
    for (const row of rows) {
      const key = `${row.kind}\u0000${row.topic}\u0000${row.aggregateId}`;
      const group = groups.get(key) ?? {
        kind: row.kind,
        topic: row.topic,
        aggregateId: row.aggregateId,
        rows: [],
      };
      group.rows.push(row);
      groups.set(key, group);
    }
    for (const group of groups.values()) await this.publishGroup(group, result);
    await this.recordBacklog();
    return result;
  }

  /** The backlog gauges (S53 FR-062): pending count and age of the oldest, parked count. Two index-backed counts. */
  private async recordBacklog(): Promise<void> {
    try {
      const [[row]] = (await this.sequelize.query(
        `SELECT (SELECT count(*) FROM "Outbox" WHERE "status" = 'pending') AS pending,
                (SELECT min("createdAt") FROM "Outbox" WHERE "status" = 'pending') AS oldest,
                (SELECT count(*) FROM "Outbox" WHERE "status" = 'parked') AS parked`,
      )) as [
        { pending: string; oldest: Date | null; parked: string }[],
        unknown,
      ];
      pendingGauge.set(Number(row.pending));
      parkedGauge.set(Number(row.parked));
      oldestPendingAge.set(
        row.oldest
          ? Math.max(0, (this.clock.nowMs() - row.oldest.getTime()) / 1000)
          : 0,
      );
    } catch (error) {
      this.logger.warn(
        `outbox backlog gauges not updated (${(error as Error).name})`,
      );
    }
  }

  private message(row: ClaimedRow) {
    return envelopeMessage(row.payload as EventEnvelope);
  }

  /** A task row goes to its queue with the row id as dedupe id (FIFO queues only; others take no dedupe id). */
  private async sendTask(row: ClaimedRow): Promise<void> {
    if (!this.tasks) throw new Error('no task queue configured');
    const { body, groupId, delaySeconds, traceparent } =
      row.payload as TaskPayload;
    const fifo = row.topic.endsWith('.fifo');
    await this.tasks.enqueue(row.topic, body, {
      ...(fifo && { dedupeId: row.id }),
      ...(groupId !== undefined && { groupId }),
      ...(delaySeconds !== undefined && { delaySeconds }),
      ...(traceparent && { attributes: { traceparent } }),
    });
  }

  private async publishGroup(group: Group, result: DrainResult): Promise<void> {
    if (group.kind === 'task') return this.publishTasks(group, result);
    try {
      await this.producer.sendMany(
        group.topic,
        group.rows.map((r) => this.message(r)),
        { profile: 'relay' },
      );
    } catch (error) {
      await this.producer.reset('relay');
      if (
        group.rows.length > 1 &&
        classifyPublishError(error) === 'non-retryable'
      )
        return this.publishRowByRow(group, result);
      return this.failGroup(group, error, result);
    }
    await this.markPublished(group.rows, result);
  }

  /** Tasks go one message at a time, in order; a failure blames that row and releases the rest. */
  private async publishTasks(group: Group, result: DrainResult): Promise<void> {
    for (let i = 0; i < group.rows.length; i++) {
      const row = group.rows[i];
      try {
        await this.sendTask(row);
      } catch (error) {
        return this.failGroup(
          { ...group, rows: group.rows.slice(i) },
          error,
          result,
        );
      }
      await this.markPublished([row], result);
    }
  }

  /** A multi-row request was rejected as a whole: find the offending row by sending the rows one at a time. */
  private async publishRowByRow(
    group: Group,
    result: DrainResult,
  ): Promise<void> {
    for (let i = 0; i < group.rows.length; i++) {
      const row = group.rows[i];
      try {
        await this.producer.sendMany(group.topic, [this.message(row)], {
          profile: 'relay',
        });
      } catch (error) {
        await this.producer.reset('relay');
        const rest = { ...group, rows: group.rows.slice(i) };
        return this.failGroup(rest, error, result);
      }
      await this.markPublished([row], result);
    }
  }

  private async markPublished(
    rows: ClaimedRow[],
    result: DrainResult,
  ): Promise<void> {
    try {
      await this.sequelize.query(
        `UPDATE "Outbox" SET "status" = 'published', "publishedAt" = $1, "leaseUntil" = NULL,
           "payload" = CASE WHEN "kind" = 'task' THEN '{}'::jsonb ELSE "payload" END WHERE "id" = ANY($2::uuid[])`,
        { bind: [this.clock.now(), rows.map((r) => r.id)] },
      );
      result.published += rows.length;
      publishedTotal.add(rows.length, { topic: rows[0].topic });
    } catch (error) {
      // Sent but not marked: the lease keeps other relays away; after it the row is sent again (at least once).
      this.logger.warn(
        `outbox rows published but not marked (${(error as Error).name}); they are re-sent after the lease: ${rows.map((r) => r.id).join(', ')}`,
      );
    }
  }

  /**
   * The first row of the group is blamed (attempt counted, backoff, or parked); the others are released untouched so
   * they follow it in order. A non-retryable rejection parks the blamed row at once.
   */
  private async failGroup(
    group: Group,
    error: unknown,
    result: DrainResult,
  ): Promise<void> {
    const [blamed, ...held] = group.rows;
    const attempts = blamed.attempts + 1;
    const nonRetryable = classifyPublishError(error) === 'non-retryable';
    const exhausted = attempts >= this.config.get('outbox_relay_max_attempts');
    const errorClass = error instanceof Error ? error.name : 'UnknownError';
    // The row id identifies the row (AS-18); the event id is envelope content and stays out of relay logs.
    const ids = `topic=${blamed.topic}`;
    publishFailures.add(1, {
      topic: blamed.topic,
      reason: nonRetryable
        ? 'NON_RETRYABLE'
        : exhausted
          ? 'MAX_ATTEMPTS'
          : 'RETRYABLE',
    });

    if (nonRetryable || exhausted) {
      const reason = nonRetryable ? 'NON_RETRYABLE' : 'MAX_ATTEMPTS';
      await this.sequelize.query(
        `UPDATE "Outbox" SET "status" = 'parked', "attempts" = $2, "parkedReason" = $3, "leaseUntil" = NULL WHERE "id" = $1`,
        { bind: [blamed.id, attempts, reason] },
      );
      result.parked++;
      // Row id and error class only: the payload never reaches a log (VIII.1).
      this.logger.error(
        `outbox row ${blamed.id} parked reasonCode=${reason} ${ids} attempts=${attempts} error=${errorClass}`,
      );
    } else {
      const next = new Date(
        this.clock.nowMs() + relayBackoffMs(attempts, this.random),
      );
      await this.sequelize.query(
        `UPDATE "Outbox" SET "attempts" = $2, "nextAttemptAt" = $3, "leaseUntil" = NULL WHERE "id" = $1`,
        { bind: [blamed.id, attempts, next] },
      );
      this.logger.warn(
        `outbox row ${blamed.id} not published ${ids} attempt=${attempts} error=${errorClass}`,
      );
    }
    result.failed++;

    if (held.length > 0) {
      await this.sequelize.query(
        `UPDATE "Outbox" SET "leaseUntil" = NULL WHERE "id" = ANY($1::uuid[])`,
        { bind: [held.map((r) => r.id)] },
      );
      result.held += held.length;
    }
  }
}
