import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import {
  KAFKA_CONSUMER_OVERRIDES,
  type KafkaClientOverrides,
} from '@app/infrastructure/kafka/kafka-client.options';
import { ConsumerLag, UnknownConsumerGroupError } from '@app/infrastructure/projections/consumer-lag';
import { ProductCreated } from '@app/domains/catalog';
import type { ProjectionLagPort } from '../domain/ports';

export const INDEXER_GROUP = 'search-indexer';

/**
 * How far `search-indexer` is behind `products.events`, in seconds: 0 when the group has committed everything (or does
 * not exist), otherwise the age of the oldest message it has not processed. Reads at most one message.
 */
@Injectable()
export class KafkaProjectionLag implements ProjectionLagPort {
  private readonly logger = new Logger(KafkaProjectionLag.name);

  constructor(
    private readonly config: ApiConfigService,
    @Optional()
    @Inject(KAFKA_CONSUMER_OVERRIDES)
    private readonly overrides: KafkaClientOverrides = {},
  ) {}

  async seconds(): Promise<number> {
    const topic = ProductCreated.topic;
    try {
      const report = await new ConsumerLag(this.config, this.overrides).read(
        INDEXER_GROUP,
        { topics: [topic] },
      );
      const behind = report.partitions.find((p) => p.lag > 0);
      if (!behind) return 0;
      const timestamp = await this.timestampAt(
        topic,
        behind.partition,
        behind.committedOffset,
      );
      return timestamp === null ? 0 : Math.max(0, (Date.now() - timestamp) / 1000);
    } catch (error) {
      if (error instanceof UnknownConsumerGroupError) return 0;
      this.logger.warn(`projection lag unknown: ${(error as Error).message}`);
      return 0;
    }
  }

  private async timestampAt(
    topic: string,
    partition: number,
    offset: number,
  ): Promise<number | null> {
    const kafka = createKafka(this.config, 'search-lag', this.overrides);
    const consumer = kafka.consumer({
      groupId: `search-lag-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    await consumer.connect();
    try {
      await consumer.subscribe({ topic, fromBeginning: true });
      return await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 3_000);
        void consumer
          .run({
            eachMessage: async ({ partition: p, message }) => {
              if (p !== partition || Number(message.offset) < offset) return;
              clearTimeout(timer);
              resolve(Number(message.timestamp));
            },
          })
          .then(() => consumer.seek({ topic, partition, offset: String(offset) }));
      });
    } finally {
      await consumer.disconnect().catch(() => undefined);
    }
  }
}
