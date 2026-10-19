import { Inject, Injectable, Optional } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { type TopicMessage } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { parseEnvelope } from '@app/infrastructure/projections/envelope-parser';
import { createKafka } from './kafka-client.factory';
import {
  KAFKA_CONSUMER_OVERRIDES,
  type KafkaClientOverrides,
} from './kafka-client.options';

/** Per partition, how many of the newest messages one call looks at: the tap serves a journey, not an archive. */
const SCAN_PER_PARTITION = 5_000;
const READ_DEADLINE_MS = 20_000;

export interface TopicTapFilter {
  type?: string;
  key?: string;
  limit: number;
}

/**
 * Read-only view of the events relayed to a topic (J03 G-41): a throwaway consumer group reads the newest messages of
 * every partition up to the end offsets of the moment of the call, keeps the envelopes that match the filter and
 * removes its group again. Nothing is produced, nothing is committed for a real group, and a message that is not an
 * envelope is skipped.
 */
@Injectable()
export class TopicTapService {
  constructor(
    private readonly config: ApiConfigService,
    @Optional()
    @Inject(KAFKA_CONSUMER_OVERRIDES)
    private readonly overrides: KafkaClientOverrides = {},
  ) {}

  async messages(topic: string, filter: TopicTapFilter): Promise<TopicMessage[]> {
    const kafka = createKafka(this.config, 'topic-tap', this.overrides);
    const admin = kafka.admin();
    await admin.connect();
    const groupId = `topic-tap-${uuidv4()}`;
    try {
      let ends: { partition: number; low: string; high: string }[];
      try {
        ends = await admin.fetchTopicOffsets(topic);
      } catch {
        return []; // the topic does not exist (yet): nothing has been relayed to it
      }
      const pending = new Map<number, number>();
      const starts: { partition: number; offset: string }[] = [];
      for (const end of ends) {
        const high = Number(end.high);
        const low = Number(end.low);
        if (high <= low) continue;
        pending.set(end.partition, high);
        starts.push({
          partition: end.partition,
          offset: String(Math.max(low, high - SCAN_PER_PARTITION)),
        });
      }
      if (pending.size === 0) return [];
      await admin.setOffsets({ groupId, topic, partitions: starts });

      const found: Array<TopicMessage & { at: number }> = [];
      const consumer = kafka.consumer({ groupId });
      await consumer.connect();
      try {
        await consumer.subscribe({ topic, fromBeginning: true });
        const done = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, READ_DEADLINE_MS);
          void consumer.run({
            eachMessage: ({ partition, message }) => {
              const parsed = parseEnvelope(message.value);
              const key = message.key?.toString('utf8') ?? '';
              if (
                parsed.ok &&
                (!filter.type || parsed.envelope.type === filter.type) &&
                (!filter.key || key === filter.key)
              ) {
                const e = parsed.envelope;
                found.push({
                  eventId: e.eventId,
                  type: e.type,
                  key,
                  version: e.aggregateVersion,
                  occurredAt: e.occurredAt,
                  payload: e.payload,
                  at: Date.parse(e.occurredAt),
                });
              }
              if (Number(message.offset) + 1 >= (pending.get(partition) ?? 0))
                pending.delete(partition);
              if (pending.size === 0) {
                clearTimeout(timer);
                resolve();
              }
              return Promise.resolve();
            },
          });
        });
        await done;
      } finally {
        await consumer.disconnect().catch(() => undefined);
      }
      return found
        .sort((a, b) => a.at - b.at)
        .slice(-filter.limit) // the newest `limit`, oldest first
        .map(({ at, ...message }) => {
          void at;
          return message;
        });
    } finally {
      await admin.deleteGroups([groupId]).catch(() => undefined);
      await admin.disconnect();
    }
  }
}
