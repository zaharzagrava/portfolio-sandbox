import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  Consumer,
  EachBatchPayload,
  KafkaMessage,
  Producer,
} from 'kafkajs';
import { ApiConfigService } from '@app/common/config';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import {
  KAFKA_CLIENT_OVERRIDES,
  type KafkaClientOverrides,
} from '@app/infrastructure/kafka/kafka-client.options';

export interface PipelineOutput {
  key?: string | Buffer | null;
  value: string | Buffer;
  headers?: Record<string, string>;
}

export interface PipelineBatch {
  topic: string;
  partition: number;
  messages: KafkaMessage[];
}

export interface PipelineSpec {
  /** Stable identity of this pipeline: a second instance with the same id fences the first (FR-061). */
  transactionalId: string;
  /** Consumer group whose offsets are committed inside the transaction. */
  groupId: string;
  inputTopic: string;
  fromBeginning?: boolean;
  /**
   * Transforms one batch. `emit` sends output messages inside the open transaction; they become visible to
   * `read_committed` readers only when the handler returns and the transaction commits, together with the input
   * offsets. A throw aborts the transaction and the batch is read again.
   */
  handle(
    batch: PipelineBatch,
    emit: (topic: string, messages: PipelineOutput[]) => Promise<void>,
  ): Promise<void>;
}

export interface PipelineHandle {
  /** True once a newer instance with the same transactional id took over; this one has stopped. */
  readonly fenced: boolean;
  stop(): Promise<void>;
}

const FENCED_TYPES = new Set(['INVALID_PRODUCER_EPOCH', 'PRODUCER_FENCED']);

function isFenced(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const { type, cause } = current as { type?: unknown; cause?: unknown };
    if (typeof type === 'string' && FENCED_TYPES.has(type)) return true;
    if (/producer.*fenced|invalid.*producer.*epoch/i.test(current.message))
      return true;
    current = cause;
  }
  return false;
}

/**
 * Consume-transform-produce with Kafka transactions (S53 FR-061): the outputs of a batch and the input offsets are
 * committed in one transaction under a stable transactional id. Aborted outputs never reach a `read_committed`
 * reader; an older instance is fenced by the broker and stops. Effects outside the log are not covered (use an inbox).
 */
@Injectable()
export class TransactionalPipeline {
  private readonly logger = new Logger(TransactionalPipeline.name);

  constructor(
    private readonly config: ApiConfigService,
    @Optional()
    @Inject(KAFKA_CLIENT_OVERRIDES)
    private readonly overrides?: KafkaClientOverrides,
  ) {}

  async run(spec: PipelineSpec): Promise<PipelineHandle> {
    const kafka = createKafka(
      this.config,
      `pipeline-${spec.transactionalId}`,
      this.overrides,
    );
    const producer: Producer = kafka.producer({
      transactionalId: spec.transactionalId,
      idempotent: true,
      maxInFlightRequests: 1,
    });
    const consumer: Consumer = kafka.consumer({
      groupId: spec.groupId,
      readUncommitted: false,
    });
    let fenced = false;
    let stopped = false;

    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await Promise.allSettled([consumer.disconnect(), producer.disconnect()]);
    };

    const onBatch = async ({
      batch,
      resolveOffset,
      heartbeat,
      isRunning,
      isStale,
    }: EachBatchPayload) => {
      if (batch.messages.length === 0 || !isRunning() || isStale()) return;
      // S54 T037 audit: Kafka transaction (not SQL); no database call inside.
      const tx = await producer.transaction();
      try {
        await spec.handle(
          {
            topic: batch.topic,
            partition: batch.partition,
            messages: batch.messages,
          },
          async (topic, messages) => {
            await tx.send({
              topic,
              messages: messages.map((m) => ({
                key: m.key ?? null,
                value: m.value,
                headers: m.headers,
              })),
            });
          },
        );
        await tx.sendOffsets({
          consumerGroupId: spec.groupId,
          topics: [
            {
              topic: batch.topic,
              partitions: [
                {
                  partition: batch.partition,
                  offset: (BigInt(batch.lastOffset()) + 1n).toString(),
                },
              ],
            },
          ],
        });
        await tx.commit();
      } catch (error) {
        await tx.abort().catch(() => undefined);
        if (isFenced(error)) {
          fenced = true;
          this.logger.warn(
            `pipeline ${spec.transactionalId} fenced by a newer instance; stopping`,
          );
          void stop();
          return;
        }
        throw error;
      }
      resolveOffset(batch.lastOffset());
      await heartbeat();
    };

    await Promise.all([producer.connect(), consumer.connect()]);
    await consumer.subscribe({
      topic: spec.inputTopic,
      fromBeginning: spec.fromBeginning ?? true,
    });
    void consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: onBatch,
    });

    return {
      get fenced() {
        return fenced;
      },
      stop,
    };
  }
}
