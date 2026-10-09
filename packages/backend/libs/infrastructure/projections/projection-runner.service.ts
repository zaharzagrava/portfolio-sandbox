import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { Consumer, EachBatchPayload, Kafka, KafkaMessage } from 'kafkajs';
import {
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TransactionRunner } from '@app/infrastructure/context';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { InboxService } from '@app/infrastructure/inbox/inbox.service';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import {
  KAFKA_CONSUMER_OVERRIDES,
  type KafkaClientOverrides,
} from '@app/infrastructure/kafka/kafka-client.options';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { coalesceLatest } from './coalesce';
import { ConsumerDeclarations } from './consumer-declaration';
import {
  classifyConsumerError,
  type ErrorClassification,
} from './consumer-error-classification';
import { DeadLetterCode, DeadLetterWriter } from './dead-letter';
import { HandlerTimeoutError } from './errors';
import { InFlightLimiter } from './in-flight-limiter';
import { parseEnvelope } from './envelope-parser';
import type { Projector, SinkCounts } from './projector';
import { ProjectionRegistry } from './projection-registry';
import { ProjectionCheckpoints } from './read-your-writes';
import { routeEnvelope } from './routing';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ` eventId=… traceId=…` for a log line, only when the message really carries them in the right shape: ids are
 * read, never any other field of the payload (VIII.1, S53 AS-106).
 */
function logIds(message: KafkaMessage): string {
  let out = '';
  try {
    const eventId = (
      JSON.parse(message.value?.toString('utf8') ?? 'null') as {
        eventId?: unknown;
      } | null
    )?.eventId;
    if (typeof eventId === 'string' && UUID.test(eventId))
      out += ` eventId=${eventId}`;
  } catch {
    // not JSON: no event id to report
  }
  const raw = message.headers?.traceparent;
  const traceId = (
    Buffer.isBuffer(raw) ? raw.toString() : String(raw ?? '')
  ).split('-')[1];
  if (traceId && /^[0-9a-f]{32}$/.test(traceId)) out += ` traceId=${traceId}`;
  return out;
}

/** Injection token of the jitter source for backoff: specs script it, production uses `Math.random`. */
export const CONSUMER_RANDOM = Symbol('CONSUMER_RANDOM');

const eventsTotal = MetricsRegistry.counter({
  name: 'consumer_events_total',
  help: 'Events a consumer saw, by outcome (applied, duplicate, stale, coalesced, ignored, dlq)',
  labels: ['consumer', 'outcome'],
});
const pausedTotal = MetricsRegistry.counter({
  name: 'consumer_paused_total',
  help: 'Times a consumer paused a partition (transient failure or backpressure)',
  labels: ['consumer', 'reason'],
});
const lagSeconds = MetricsRegistry.histogram({
  name: 'projection_lag_seconds',
  help: 'Time from event occurrence to its effect, recorded after the effect succeeded',
  labels: ['consumer'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
});

/**
 * Thrown inside a batch when the group is rebalancing or the consumer is stopping and a wait must give up: no new
 * work is started and nothing more is committed; the uncommitted rest is redelivered (to this member or to the new
 * owner of the partition).
 */
class ConsumerStopping extends Error {}

/**
 * The store is unwell or saturated: the failed chunk is left unresolved, the partition is paused for `delayMs` and
 * resumed afterwards, so the events come back in order. Pausing instead of sleeping inside the handler matters: the
 * client fetches all partitions of a broker in one cycle and waits for every batch of it, so a handler that sleeps
 * would stall the other partitions too.
 */
class PartitionPause extends Error {
  constructor(
    readonly delayMs: number,
    readonly reason: 'transient' | 'backpressure',
  ) {
    super('partition paused');
  }
}

const isRebalanceError = (error: unknown): boolean =>
  [
    'REBALANCE_IN_PROGRESS',
    'NOT_COORDINATOR_FOR_GROUP',
    'ILLEGAL_GENERATION',
    'UNKNOWN_MEMBER_ID',
  ].includes((error as { type?: string } | undefined)?.type ?? '');

/** A valid message on its way through the batch: the envelope as the handler will see it, and where it came from. */
interface Delivery {
  envelope: EventEnvelope;
  /** The envelope as it arrived (before upgrade): checkpoints and lag refer to the stream, not the upgrade. */
  arrived: EventEnvelope;
  topic: string;
  partition: number;
  message: KafkaMessage;
}

interface ConsumerState {
  projector: Projector;
  consumer: Consumer;
  limiter: InFlightLimiter;
  stopping: boolean;
  /** The group told us to rejoin: running batches stop starting work so the partition can move cleanly. */
  rebalancing: boolean;
  /** Batches inside `handleBatch` right now (partitions are consumed concurrently). */
  active: number;
  /** Consecutive pauses per partition, for the growth of the backoff; cleared by the next success. */
  pauses: Map<string, number>;
  /** Pending resumes, cancelled on stop. */
  resumeTimers: Set<NodeJS.Timeout>;
}

const MAX_PARTITIONS_AT_ONCE = 8;

/**
 * Runs consumers as independent Kafka consumer groups (S53 FR-024 to FR-040):
 *  - validate every message as an envelope, route by `(type, version)`, upgrade older versions, validate payloads;
 *  - hand the handler validated batches, one chunk at a time per partition, never more than 500 events inside;
 *  - commit offsets only after the effects (and dead letters) of everything up to them;
 *  - transient failures pause the partition and retry later and never dead-letter; permanent ones spend the
 *    attempt budget, then go to `<consumer>.dlq` with a reason code; a dead letter that cannot be written holds
 *    the offset;
 *  - stop gracefully: the in-flight batch finishes and commits, then the connection closes.
 */
@Injectable()
export class ProjectionRunner implements OnModuleDestroy {
  private readonly logger = new Logger(ProjectionRunner.name);
  private readonly declarations = new ConsumerDeclarations();
  private readonly states: ConsumerState[] = [];
  private readonly kafka: Kafka;

  constructor(
    private readonly config: ApiConfigService,
    private readonly checkpoints: ProjectionCheckpoints,
    private readonly deadLetters: DeadLetterWriter,
    private readonly inbox: InboxService,
    private readonly transactions: TransactionRunner,
    private readonly registry: ProjectionRegistry,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
    @Optional()
    @Inject(CONSUMER_RANDOM)
    private readonly random: () => number = Math.random,
    @Optional()
    @Inject(KAFKA_CONSUMER_OVERRIDES)
    overrides: KafkaClientOverrides = {},
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    this.kafka = createKafka(config, 'projection-runner', overrides);
    shutdown?.register({
      name: 'projections.stop',
      order: 10,
      run: () => this.stopAll(),
      timeoutMs: config.get('consumer_graceful_stop_ms'),
    });
  }

  /** Validates every declaration first (a wrong one fails the whole startup), then starts each consumer. */
  async startAll(projectors: Projector[]): Promise<void> {
    for (const projector of projectors) this.declarations.register(projector);
    for (const projector of projectors) await this.startConsumer(projector);
  }

  async start(projector: Projector): Promise<void> {
    await this.startAll([projector]);
  }

  private async startConsumer(projector: Projector): Promise<void> {
    const consumer = this.kafka.consumer({
      groupId: projector.name,
      // Fewer, bigger batches: sinks are bulk-oriented (ES _bulk, pipelines, batch writes).
      maxBytesPerPartition: 1024 * 1024,
      minBytes: 1,
      maxWaitTimeInMs: 50,
      sessionTimeout: this.config.get('consumer_session_timeout_ms'),
      heartbeatInterval: this.heartbeatMs(),
    });
    const state: ConsumerState = {
      projector,
      consumer,
      limiter: new InFlightLimiter(this.config.get('consumer_in_flight')),
      stopping: false,
      rebalancing: false,
      active: 0,
      pauses: new Map(),
      resumeTimers: new Set(),
    };
    // Operator tools read the declaration (topics, replayable) from outside the process; Redis being down must not
    // keep a consumer from starting.
    await this.registry
      .declare(projector)
      .catch((error) =>
        this.logger.warn(
          `could not record the declaration of ${projector.name} (${(error as Error).name})`,
        ),
      );
    await consumer.connect();
    for (const topic of projector.topics)
      await consumer.subscribe({
        topic,
        // A group that may not be replayed starts at the end: it must never read history it was not built for.
        fromBeginning: projector.replayable !== false,
      });
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: MAX_PARTITIONS_AT_ONCE,
      eachBatch: (payload) => this.handleBatch(state, payload),
    });
    this.states.push(state);
    this.logger.log(
      `consumer ${projector.name} started on ${projector.topics.join(', ')} (${projector.idempotency})`,
    );
  }

  private async handleBatch(
    state: ConsumerState,
    payload: EachBatchPayload,
  ): Promise<void> {
    const { batch, resolveOffset, heartbeat, isRunning, isStale } = payload;
    const { projector } = state;
    if (!isRunning() || isStale() || state.stopping) return;
    // A batch delivered while nothing else runs belongs to the current generation.
    if (state.active === 0) state.rebalancing = false;
    state.active++;

    const stopHeartbeat = this.keepAlive(state, heartbeat);
    const commit = async (offset: string) => {
      resolveOffset(String(BigInt(offset) - 1n));
      await state.consumer.commitOffsets([
        { topic: batch.topic, partition: batch.partition, offset },
      ]);
    };
    try {
      const deliveries: Delivery[] = [];
      const skipped: EventEnvelope[] = [];
      for (const message of batch.messages) {
        const parsed = parseEnvelope(message.value);
        if (!parsed.ok) {
          await this.deadLetter(
            state,
            batch.topic,
            batch.partition,
            message,
            parsed.code,
            parsed.reason,
            0,
          );
          continue;
        }
        const routed = routeEnvelope(
          projector.handles,
          parsed.envelope,
          projector.aggregateIdSchema,
        );
        if (routed.kind === 'skip') {
          skipped.push(parsed.envelope);
          eventsTotal.add(1, { consumer: projector.name, outcome: 'ignored' });
        } else if (routed.kind === 'reject') {
          await this.deadLetter(
            state,
            batch.topic,
            batch.partition,
            message,
            routed.code,
            routed.reason,
            0,
          );
        } else {
          deliveries.push({
            envelope: routed.envelope,
            arrived: parsed.envelope,
            topic: batch.topic,
            partition: batch.partition,
            message,
          });
        }
      }

      const toApply = projector.coalesce
        ? this.coalesceDeliveries(deliveries)
        : deliveries;
      if (toApply.length < deliveries.length)
        eventsTotal.add(deliveries.length - toApply.length, {
          consumer: projector.name,
          outcome: 'coalesced',
        });

      const progress = { done: 0 };
      try {
        await this.withBatchSpan(
          state,
          batch.topic,
          batch.partition,
          toApply,
          () =>
            this.applyAll(
              state,
              batch.topic,
              batch.partition,
              toApply,
              heartbeat,
              progress,
            ),
        );
      } catch (error) {
        if (!(error instanceof PartitionPause)) throw error;
        // Commit what is done (everything before the first unapplied event), pause the partition, come back later.
        const next = toApply[progress.done];
        if (progress.done > 0 && next) {
          const upTo = Number(next.message.offset);
          await this.finish(
            state,
            deliveries.filter((d) => Number(d.message.offset) < upTo),
            [],
          );
          await commit(next.message.offset);
        }
        this.pausePartition(state, batch.topic, batch.partition, error);
        return;
      }

      // Everything in the batch is applied or dead-lettered: checkpoints, lag, then the offset.
      await this.finish(state, deliveries, skipped);
      const last = batch.messages[batch.messages.length - 1];
      if (last) {
        this.assertNotRebalancing(state);
        await commit((BigInt(last.offset) + 1n).toString());
      }
    } catch (error) {
      if (error instanceof ConsumerStopping) return; // the uncommitted rest is redelivered
      throw error;
    } finally {
      stopHeartbeat();
      state.active--;
      // kafkajs rejoins as soon as one worker returns. Hold this one until every batch of the consumer has stopped,
      // so no partition is still being handled here when it is assigned to another member (FR-030).
      if (state.rebalancing) await this.waitIdle(state);
    }
  }

  /** Checkpoints and lag, recorded after the effects succeeded (a failing checkpoint store never fails a batch). */
  private async finish(
    state: ConsumerState,
    deliveries: Delivery[],
    skipped: EventEnvelope[],
  ): Promise<void> {
    await this.checkpoints
      .record(state.projector.name, [
        ...deliveries.map((d) => d.arrived),
        ...skipped,
      ])
      .catch((error) =>
        this.logger.warn(
          `checkpoint store unavailable (${(error as Error).name}), read-your-writes falls back`,
        ),
      );
    const now = this.clock.nowMs();
    for (const d of deliveries)
      lagSeconds.record(
        Math.max(0, (now - Date.parse(d.arrived.occurredAt)) / 1000),
        {
          consumer: state.projector.name,
        },
      );
  }

  private pausePartition(
    state: ConsumerState,
    topic: string,
    partition: number,
    pause: PartitionPause,
  ): void {
    state.consumer.pause([{ topic, partitions: [partition] }]);
    const timer = setTimeout(() => {
      state.resumeTimers.delete(timer);
      if (!state.stopping)
        state.consumer.resume([{ topic, partitions: [partition] }]);
    }, pause.delayMs);
    timer.unref();
    state.resumeTimers.add(timer);
  }

  private async waitIdle(
    state: ConsumerState,
    timeoutMs = 30_000,
  ): Promise<void> {
    for (let waited = 0; state.active > 0 && waited < timeoutMs; waited += 10)
      await sleep(10);
  }

  private heartbeatMs(): number {
    return Math.max(
      1_000,
      Math.floor(this.config.get('consumer_session_timeout_ms') / 10),
    );
  }

  /** One span per batch, a child of the producer's trace when the first message carries `traceparent` (FR-023). */
  private async withBatchSpan<T>(
    state: ConsumerState,
    topic: string,
    partition: number,
    deliveries: Delivery[],
    work: () => Promise<T>,
  ): Promise<T> {
    const carrier: Record<string, string> = {};
    const header =
      deliveries[0]?.message.headers?.traceparent ??
      deliveries[0]?.arrived.traceparent;
    if (header)
      carrier.traceparent = Buffer.isBuffer(header)
        ? header.toString()
        : String(header);
    const parent = propagation.extract(context.active(), carrier);
    return trace.getTracer('projections').startActiveSpan(
      `project ${state.projector.name}`,
      {
        attributes: {
          'projection.name': state.projector.name,
          'messaging.destination.name': topic,
          'messaging.kafka.partition': partition,
          'projection.batch_size': deliveries.length,
        },
      },
      parent,
      async (span) => {
        try {
          return await work();
        } catch (error) {
          // A pause is flow control, not a failure of the span.
          if (!(error instanceof PartitionPause)) {
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  private coalesceDeliveries(deliveries: Delivery[]): Delivery[] {
    const keep = new Set(coalesceLatest(deliveries.map((d) => d.envelope)));
    return deliveries.filter((d) => keep.has(d.envelope));
  }

  /** Handler chunks, in log order, each at most `consumer_batch` events and never more than the in-flight limit. */
  private async applyAll(
    state: ConsumerState,
    topic: string,
    partition: number,
    deliveries: Delivery[],
    heartbeat: () => Promise<void>,
    progress: { done: number },
  ): Promise<void> {
    const size = Math.max(
      1,
      Math.min(
        this.config.get('consumer_batch'),
        this.config.get('consumer_in_flight'),
      ),
    );
    for (let i = 0; i < deliveries.length; i += size) {
      // A revoked partition belongs to someone else now: start nothing more, commit nothing.
      if (i > 0) this.assertNotRebalancing(state);
      const chunk = deliveries.slice(i, i + size);
      await this.applyChunk(state, topic, partition, chunk, heartbeat);
      progress.done += chunk.length;
      state.pauses.delete(`${topic}:${partition}`);
    }
  }

  private async applyChunk(
    state: ConsumerState,
    topic: string,
    partition: number,
    chunk: Delivery[],
    heartbeat: () => Promise<void>,
  ): Promise<void> {
    try {
      this.count(
        state,
        await this.invoke(
          state,
          chunk.map((d) => d.envelope),
        ),
      );
    } catch (error) {
      this.pauseIfTransient(state, topic, partition, error);
      // A permanent failure of the chunk counts as the first attempt of every event in it, then the events are
      // tried one at a time so one poison event cannot take its neighbours down.
      for (const delivery of chunk)
        await this.applyOne(
          state,
          topic,
          partition,
          delivery,
          1,
          error,
          heartbeat,
        );
    }
  }

  private async applyOne(
    state: ConsumerState,
    topic: string,
    partition: number,
    delivery: Delivery,
    used: number,
    lastError: unknown,
    heartbeat: () => Promise<void>,
  ): Promise<void> {
    const budget =
      state.projector.attempts ?? this.config.get('consumer_max_attempts');
    for (;;) {
      if (used >= budget) {
        const errorClass =
          lastError instanceof Error ? lastError.name : 'UnknownError';
        await this.deadLetter(
          state,
          topic,
          partition,
          delivery.message,
          'HANDLER_FAILED',
          `handler failed after ${used} attempt(s): ${errorClass}`,
          used,
        );
        return;
      }
      await this.waitFor(
        fullJitterBackoff(used - 1, this.backoff(), this.random),
        state,
        heartbeat,
      );
      try {
        this.count(state, await this.invoke(state, [delivery.envelope]));
        return;
      } catch (error) {
        this.pauseIfTransient(state, topic, partition, error);
        used++;
        lastError = error;
      }
    }
  }

  /**
   * A transient failure (not a handler timeout) leaves the chunk for later: pause the partition, never a dead letter.
   * A timeout is transient too (the group session stays alive, no rebalance) but still spends an attempt: a handler
   * that hangs on one event must not hold the partition forever.
   */
  private pauseIfTransient(
    state: ConsumerState,
    topic: string,
    partition: number,
    error: unknown,
  ): void {
    const classified = classifyConsumerError(error);
    if (
      classified.class !== 'transient' ||
      error instanceof HandlerTimeoutError
    )
      return;
    throw this.pauseFor(state, topic, partition, classified);
  }

  private pauseFor(
    state: ConsumerState,
    topic: string,
    partition: number,
    classified: ErrorClassification,
  ): PartitionPause {
    const key = `${topic}:${partition}`;
    const attempt = state.pauses.get(key) ?? 0;
    state.pauses.set(key, attempt + 1);
    const reason =
      classified.retryAfterMs !== undefined ? 'backpressure' : 'transient';
    pausedTotal.add(1, { consumer: state.projector.name, reason });
    return new PartitionPause(
      classified.retryAfterMs ??
        fullJitterBackoff(attempt, this.backoff(), this.random),
      reason,
    );
  }

  /** The handler call: bounded in flight, in the inbox transaction when declared, under the handler timeout. */
  private async invoke(
    state: ConsumerState,
    events: EventEnvelope[],
  ): Promise<SinkCounts> {
    const { projector } = state;
    const release = await state.limiter.acquire(events.length);
    let timer: NodeJS.Timeout | undefined;
    try {
      const work =
        projector.idempotency === 'inbox'
          ? this.invokeInbox(projector, events)
          : this.invokePlain(projector, events);
      const timeoutMs = this.config.get('consumer_handler_timeout_ms');
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new HandlerTimeoutError(timeoutMs)),
          timeoutMs,
        );
      });
      work.catch(() => undefined); // an abandoned (timed out) call must not become an unhandled rejection
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  private async invokePlain(
    projector: Projector,
    events: EventEnvelope[],
  ): Promise<SinkCounts> {
    return this.normalise(await projector.project(events), events.length, 0);
  }

  /** `(consumer, eventId)` is recorded in the same transaction as the effect; a rolled-back effect leaves no record. */
  private invokeInbox(
    projector: Projector,
    events: EventEnvelope[],
  ): Promise<SinkCounts> {
    return this.transactions.run(async () => {
      const fresh: EventEnvelope[] = [];
      let duplicate = 0;
      for (const event of events) {
        if (await this.inbox.recordOnce(projector.name, event.eventId))
          fresh.push(event);
        else duplicate++;
      }
      const result =
        fresh.length > 0 ? await projector.project(fresh) : undefined;
      return this.normalise(result, fresh.length, duplicate);
    });
  }

  private normalise(
    result: void | SinkCounts,
    handled: number,
    duplicates: number,
  ): SinkCounts {
    const counts: SinkCounts = result
      ? { ...result }
      : { applied: handled, duplicate: 0, stale: 0 };
    counts.duplicate += duplicates;
    return counts;
  }

  private count(state: ConsumerState, counts: SinkCounts): void {
    for (const outcome of ['applied', 'duplicate', 'stale'] as const)
      if (counts[outcome] > 0)
        eventsTotal.add(counts[outcome], {
          consumer: state.projector.name,
          outcome,
        });
  }

  private backoff() {
    return {
      baseMs: this.config.get('consumer_backoff_min_ms'),
      maxMs: this.config.get('consumer_backoff_max_ms'),
    };
  }

  /** Waits `ms` in slices, keeping the group session alive and giving up if the consumer is stopping. */
  private async waitFor(
    ms: number,
    state: ConsumerState,
    heartbeat: () => Promise<void>,
  ): Promise<void> {
    let left = ms;
    while (left > 0) {
      this.assertActive(state);
      const slice = Math.min(left, this.heartbeatMs() / 2);
      await sleep(slice);
      left -= slice;
      await this.beat(state, heartbeat);
    }
    this.assertActive(state);
  }

  /** Between chunks and before a commit only a rebalance stops us: a stop lets the in-flight batch finish. */
  private assertNotRebalancing(state: ConsumerState): void {
    if (state.rebalancing) throw new ConsumerStopping();
  }

  /** In a wait there is no point in continuing when the consumer stops or the partition moves. */
  private assertActive(state: ConsumerState): void {
    if (state.stopping || state.rebalancing) throw new ConsumerStopping();
  }

  /** A heartbeat that remembers a rebalance instead of throwing it into the handler's retry loop. */
  private async beat(
    state: ConsumerState,
    heartbeat: () => Promise<void>,
  ): Promise<void> {
    try {
      await heartbeat();
    } catch (error) {
      if (isRebalanceError(error)) state.rebalancing = true;
    }
  }

  private keepAlive(
    state: ConsumerState,
    heartbeat: () => Promise<void>,
  ): () => void {
    const timer = setInterval(
      () => void this.beat(state, heartbeat),
      this.heartbeatMs(),
    );
    return () => clearInterval(timer);
  }

  private async deadLetter(
    state: ConsumerState,
    topic: string,
    partition: number,
    message: KafkaMessage,
    code: DeadLetterCode,
    reason: string,
    attempts: number,
  ): Promise<void> {
    // Reason code and schema paths only: the message content never reaches a log (VIII.1).
    this.logger.warn(
      `dead letter consumer=${state.projector.name} topic=${topic} partition=${partition} offset=${message.offset} reasonCode=${code}${logIds(message)}`,
    );
    await this.deadLetters.write({
      consumer: state.projector.name,
      topic,
      partition,
      offset: message.offset,
      key: message.key,
      value: message.value,
      code,
      reason,
      attempts,
      redriveCount: this.redriveCountOf(message),
    });
    eventsTotal.add(1, { consumer: state.projector.name, outcome: 'dlq' });
  }

  /** A redriven message arrives with `x-redrive-count`; a second dead letter must carry it forward. */
  private redriveCountOf(message: KafkaMessage): number {
    const raw = message.headers?.['x-redrive-count'];
    const value = Number(Buffer.isBuffer(raw) ? raw.toString() : raw);
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopAll();
  }

  /**
   * Graceful stop (FR-039): no new batch is started, the in-flight batches finish and commit, and only then the
   * connections close, within `consumer_graceful_stop_ms`. Closing first would race the final commit against the
   * client leaving the group.
   */
  async stopAll(): Promise<void> {
    const states = this.states.splice(0);
    for (const state of states) {
      state.stopping = true;
      for (const timer of state.resumeTimers) clearTimeout(timer);
      state.resumeTimers.clear();
    }
    const budget = this.config.get('consumer_graceful_stop_ms');
    await Promise.allSettled(
      states.map(async (state) => {
        await this.waitIdle(state, Math.max(1_000, budget - 2_000));
        await state.consumer.disconnect();
      }),
    );
  }
}
