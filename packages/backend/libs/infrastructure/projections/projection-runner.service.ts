import { Injectable, Logger, Optional } from '@nestjs/common';
import { Consumer, EachBatchPayload, Producer } from 'kafkajs';
import { metrics, trace, SpanStatusCode } from '@opentelemetry/api';
import { ApiConfigService } from '@app/common/config';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { coalesceLatest, Projector, SinkBackpressureError } from './projector';
import { parseEnvelope } from './envelope-parser';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';

const MAX_BATCH_ATTEMPTS = 3;

/**
 * Runs projectors as independent Kafka consumer groups (D26):
 *  - batch processing per partition (`eachBatch`), offsets resolved only after
 *    the sink write → at-least-once; sinks are version-guarded → effectively once;
 *  - poison messages (unparseable / failing alone after retries) go to
 *    `<projector>.dlq` instead of blocking the partition;
 *  - SinkBackpressureError pauses the partition and resumes after the hint;
 *  - projection lag histogram (`now - occurredAt`) per projector;
 *  - stopped first on shutdown (ShutdownRegistry order 10) after finishing the
 *    in-flight batch, so offsets are committed for work actually done.
 */
@Injectable()
export class ProjectionRunner {
  private readonly logger = new Logger(ProjectionRunner.name);
  private readonly consumers: Consumer[] = [];
  private producer?: Producer;
  /** Exported as projection_lag_seconds (SLI for read-model freshness, alert ProjectionLagHigh). */
  private readonly lag = metrics
    .getMeter('projections')
    .createHistogram('projection.lag', {
      description: 'Time from event occurrence to read-model write',
      unit: 's',
      advice: {
        explicitBucketBoundaries: [
          0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300,
        ],
      },
    });
  private readonly tracer = trace.getTracer('projections');

  constructor(
    private readonly config: ApiConfigService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    shutdown?.register({
      name: 'projections.stop',
      order: 10,
      run: () => this.stopAll(),
      timeoutMs: 20_000,
    });
  }

  async start(projector: Projector): Promise<void> {
    const kafka = createKafka(this.config, `projector-${projector.name}`);
    if (!this.producer) {
      this.producer = kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
      });
      await this.producer.connect();
    }

    const consumer = kafka.consumer({
      groupId: projector.name,
      // Fewer, bigger batches: sinks are bulk-oriented (ES _bulk, pipelines, batch writes).
      maxBytesPerPartition: 1024 * 1024,
      minBytes: 1,
      maxWaitTimeInMs: 50,
    });
    await consumer.connect();
    for (const topic of projector.topics) {
      await consumer.subscribe({ topic, fromBeginning: true });
    }

    await consumer.run({
      autoCommit: true,
      eachBatchAutoResolve: false,
      eachBatch: (payload) => this.handleBatch(projector, consumer, payload),
    });

    this.consumers.push(consumer);
    this.logger.log(
      `Projector ${projector.name} started on ${projector.topics.join(', ')}`,
    );
  }

  private async handleBatch(
    projector: Projector,
    consumer: Consumer,
    payload: EachBatchPayload,
  ): Promise<void> {
    const {
      batch,
      resolveOffset,
      heartbeat,
      isRunning,
      isStale,
      commitOffsetsIfNecessary,
    } = payload;
    if (!isRunning() || isStale()) return;

    const valid: EventEnvelope[] = [];
    for (const message of batch.messages) {
      const result = parseEnvelope(
        batch.topic,
        message.key?.toString() ?? null,
        message.value,
        message.offset,
      );
      if (result.ok) valid.push(result.envelope);
      else
        await this.toDlq(
          projector,
          batch.topic,
          message.key,
          message.value,
          result.reason,
        );
    }

    const toProject = projector.coalesce ? coalesceLatest(valid) : valid;

    await this.tracer.startActiveSpan(
      `project ${projector.name}`,
      async (span) => {
        span.setAttributes({
          'projection.name': projector.name,
          'projection.batch_size': toProject.length,
        });
        try {
          await this.projectWithRetries(
            projector,
            consumer,
            batch.topic,
            batch.partition,
            toProject,
          );
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );

    const now = Date.now();
    for (const event of valid)
      this.lag.record((now - Date.parse(event.occurredAt)) / 1000, {
        projector: projector.name,
      });

    for (const message of batch.messages) resolveOffset(message.offset);
    await commitOffsetsIfNecessary();
    await heartbeat();
  }

  private async projectWithRetries(
    projector: Projector,
    consumer: Consumer,
    topic: string,
    partition: number,
    events: EventEnvelope[],
  ): Promise<void> {
    if (events.length === 0) return;

    for (let attempt = 0; attempt < MAX_BATCH_ATTEMPTS; attempt++) {
      try {
        await projector.project(events);
        return;
      } catch (error) {
        if (error instanceof SinkBackpressureError) {
          // Backpressure: stop fetching this partition instead of hammering a saturated store.
          consumer.pause([{ topic, partitions: [partition] }]);
          await sleep(error.retryAfterMs);
          consumer.resume([{ topic, partitions: [partition] }]);
          attempt--; // backpressure isn't a failure of the batch
          continue;
        }
        this.logger.warn(
          `[${projector.name}] batch attempt ${attempt + 1} failed: ${(error as Error).message}`,
        );
        await sleep(fullJitterBackoff(attempt, { baseMs: 200, maxMs: 5_000 }));
      }
    }

    // The batch keeps failing: isolate the poison event(s) one by one so the rest of the partition proceeds.
    for (const event of events) {
      try {
        await projector.project([event]);
      } catch (error) {
        await this.toDlq(
          projector,
          topic,
          Buffer.from(event.aggregateId),
          Buffer.from(JSON.stringify(event)),
          (error as Error).message,
        );
      }
    }
  }

  private async toDlq(
    projector: Projector,
    topic: string,
    key: Buffer | null,
    value: Buffer | null,
    reason: string,
  ) {
    this.logger.error(`[${projector.name}] → DLQ (${topic}): ${reason}`);
    await this.producer!.send({
      topic: `${projector.name}.dlq`,
      messages: [
        {
          key,
          value,
          headers: {
            'x-source-topic': topic,
            'x-dlq-reason': reason.slice(0, 500),
          },
        },
      ],
    });
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.consumers.map((c) => c.disconnect()));
    await this.producer?.disconnect();
  }
}
