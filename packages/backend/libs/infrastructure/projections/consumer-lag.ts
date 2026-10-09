import { Inject, Injectable, Optional } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import {
  KAFKA_CONSUMER_OVERRIDES,
  type KafkaClientOverrides,
} from '@app/infrastructure/kafka/kafka-client.options';

export class UnknownConsumerGroupError extends Error {
  constructor(readonly group: string) {
    super(`Consumer group "${group}" does not exist`);
    this.name = 'UnknownConsumerGroupError';
  }
}

export interface PartitionLag {
  topic: string;
  partition: number;
  /** The offset of the next message the group will read (what it committed). */
  committedOffset: number;
  endOffset: number;
  lag: number;
}

export interface LagReport {
  partitions: PartitionLag[];
  totalLag: number;
  caughtUp: boolean;
}

/**
 * How far behind a consumer group is (S53 FR-056): committed against end offsets per partition, never negative.
 * An operator answers "how far behind is consumer X" from this alone (SC-007). A group nobody ever created raises
 * `UnknownConsumerGroupError`; pass `topics` for a group that exists but has not committed anything yet, so its whole
 * backlog counts as lag.
 */
@Injectable()
export class ConsumerLag {
  constructor(
    private readonly config: ApiConfigService,
    @Optional()
    @Inject(KAFKA_CONSUMER_OVERRIDES)
    private readonly overrides: KafkaClientOverrides = {},
  ) {}

  async read(
    group: string,
    options: { topics?: string[] } = {},
  ): Promise<LagReport> {
    const admin = createKafka(
      this.config,
      'consumer-lag',
      this.overrides,
    ).admin();
    await admin.connect();
    try {
      const [description] = (await admin.describeGroups([group])).groups;
      const committed = await admin.fetchOffsets({
        groupId: group,
        topics: options.topics,
      });
      const known =
        description.state !== 'Dead' ||
        committed.some((t) => t.partitions.some((p) => Number(p.offset) >= 0));
      if (!known) throw new UnknownConsumerGroupError(group);

      const topics = options.topics ?? committed.map((t) => t.topic);
      const partitions: PartitionLag[] = [];
      for (const topic of topics) {
        const ends = await admin.fetchTopicOffsets(topic);
        const stored =
          committed.find((t) => t.topic === topic)?.partitions ?? [];
        for (const end of ends) {
          const offset = Number(
            stored.find((p) => p.partition === end.partition)?.offset ?? -1,
          );
          // Nothing committed yet: the group starts at the oldest retained offset.
          const committedOffset = offset < 0 ? Number(end.low) : offset;
          partitions.push({
            topic,
            partition: end.partition,
            committedOffset,
            endOffset: Number(end.high),
            lag: Math.max(0, Number(end.high) - committedOffset),
          });
        }
      }
      const totalLag = partitions.reduce((sum, p) => sum + p.lag, 0);
      return { partitions, totalLag, caughtUp: totalLag === 0 };
    } finally {
      await admin.disconnect();
    }
  }
}
