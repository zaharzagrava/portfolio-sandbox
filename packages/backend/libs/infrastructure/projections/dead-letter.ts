import { Inject, Injectable, Optional } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import {
  KAFKA_CLIENT_OVERRIDES,
  type KafkaClientOverrides,
} from '@app/infrastructure/kafka/kafka-client.options';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';

export type DeadLetterCode =
  | 'INVALID_ENVELOPE'
  | 'INVALID_PAYLOAD'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_AGGREGATE_ID'
  | 'HANDLER_FAILED';

export interface DeadLetter {
  consumer: string;
  topic: string;
  partition: number;
  offset: string;
  /** The original bytes, unchanged. */
  key: Buffer | null;
  value: Buffer | null;
  code: DeadLetterCode;
  /** Error class and schema paths only, never a payload value. */
  reason: string;
  /** Handler attempts used (0 for a message rejected before any handler ran). */
  attempts: number;
  /** Times an operator already redrove this message; carried forward so the limit of 3 holds. */
  redriveCount?: number;
}

export const deadLetterTopic = (consumer: string): string => `${consumer}.dlq`;
const REASON_MAX = 500;

const dlqTotal = MetricsRegistry.counter({
  name: 'dlq_total',
  help: 'Messages written to a consumer dead-letter topic',
  labels: ['consumer', 'reason'],
});
const dlqWriteFailures = MetricsRegistry.counter({
  name: 'dlq_write_failures_total',
  help: 'Dead letters that could not be written (the batch is not committed)',
  labels: ['consumer'],
});

/**
 * Writes `<consumer>.dlq` records (S53 FR-037, `contracts/dead-letter.md`): the original key and value bytes plus the
 * header set that says where the message came from and why it failed. The topic is created on first use. A failed
 * write throws and increments `dlq_write_failures_total`: the caller must not commit the offset.
 */
@Injectable()
export class DeadLetterWriter {
  private readonly ensured = new Set<string>();

  constructor(
    private readonly producer: KafkaProducerService,
    private readonly config: ApiConfigService,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
    @Optional()
    @Inject(KAFKA_CLIENT_OVERRIDES)
    private readonly overrides: KafkaClientOverrides = {},
  ) {}

  async write(letter: DeadLetter): Promise<void> {
    const topic = deadLetterTopic(letter.consumer);
    try {
      await this.ensureTopic(topic);
      await this.producer.sendMany(topic, [
        {
          key: letter.key,
          value: letter.value ?? Buffer.alloc(0),
          headers: {
            'x-source-topic': letter.topic,
            'x-source-partition': String(letter.partition),
            'x-source-offset': letter.offset,
            'x-consumer': letter.consumer,
            'x-dlq-reason-code': letter.code,
            'x-dlq-reason': letter.reason.slice(0, REASON_MAX),
            'x-attempts': String(letter.attempts),
            'x-failed-at': this.clock.now().toISOString(),
            ...(letter.redriveCount
              ? { 'x-redrive-count': String(letter.redriveCount) }
              : {}),
          },
        },
      ]);
    } catch (error) {
      dlqWriteFailures.add(1, { consumer: letter.consumer });
      throw error;
    }
    dlqTotal.add(1, { consumer: letter.consumer, reason: letter.code });
  }

  private async ensureTopic(topic: string): Promise<void> {
    if (this.ensured.has(topic)) return;
    const admin = createKafka(this.config, 'dead-letter-admin', {
      connectionTimeout: 3_000,
      retry: { retries: 0 },
      ...this.overrides,
    }).admin();
    await admin.connect();
    try {
      await admin.createTopics({
        waitForLeaders: true,
        topics: [{ topic, numPartitions: 1 }],
      });
    } finally {
      await admin.disconnect();
    }
    this.ensured.add(topic);
  }
}
