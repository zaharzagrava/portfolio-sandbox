import type { Consumer, EachBatchPayload, KafkaMessage } from 'kafkajs';
import type { ApiConfigService } from '@app/common/config';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';

export interface BatchConsumerSpec {
  clientId: string;
  groupId: string;
  topic: string;
  /** `false` reads only committed transactional output (the aggregates topic); the raw click log needs no such care. */
  readCommitted: boolean;
  /** Handles the messages of one partition batch in order. A throw makes kafkajs redeliver the batch. */
  handle(batch: {
    partition: number;
    firstOffset: string;
    lastOffset: string;
    messages: KafkaMessage[];
  }): Promise<void>;
}

export interface BatchConsumerHandle {
  stop(): Promise<void>;
}

/**
 * A plain kafkajs consumer for the two ClickHouse writers of S36 (S53 G-44): batches per partition, offsets resolved and
 * committed after the handler returns, a new group reads from the earliest offset. Not an S53 projector: these topics
 * carry click records and minute aggregates, not event envelopes.
 */
export async function startBatchConsumer(
  config: ApiConfigService,
  spec: BatchConsumerSpec,
): Promise<BatchConsumerHandle> {
  const kafka = createKafka(config, spec.clientId);
  const consumer: Consumer = kafka.consumer({
    groupId: spec.groupId,
    readUncommitted: !spec.readCommitted,
  });
  await consumer.connect();
  await consumer.subscribe({ topic: spec.topic, fromBeginning: true });
  void consumer
    .run({
      eachBatch: async ({
        batch,
        heartbeat,
        isRunning,
        isStale,
      }: EachBatchPayload) => {
        if (batch.messages.length === 0 || !isRunning() || isStale()) return;
        await spec.handle({
          partition: batch.partition,
          firstOffset: batch.firstOffset() ?? batch.messages[0].offset,
          lastOffset: batch.lastOffset(),
          messages: batch.messages,
        });
        await heartbeat();
      },
    })
    .catch(() => undefined);
  return {
    async stop() {
      await consumer.disconnect().catch(() => undefined);
    },
  };
}
