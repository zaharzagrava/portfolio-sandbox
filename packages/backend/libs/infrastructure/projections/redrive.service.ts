import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import {
  KAFKA_CLIENT_OVERRIDES,
  type KafkaClientOverrides,
} from '@app/infrastructure/kafka/kafka-client.options';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { deadLetterTopic } from './dead-letter';

/** A message already redriven this many times is not redriven again (S53 FR-038). */
export const MAX_REDRIVES = 3;

export interface RedriveResult {
  redriven: number;
  /** Dead letters left alone because they reached the redrive limit. */
  refused: number;
}

/**
 * Operator tool (`projections:redrive`): republishes the dead letters of a consumer to their source topic with the
 * original key and bytes and an incremented `x-redrive-count`. Progress is committed in the group
 * `<consumer>.redrive`, so running it again redrives only dead letters written since. A dead letter that carries the
 * count of 3 is left in the topic for a human.
 */
@Injectable()
export class RedriveService {
  private readonly logger = new Logger(RedriveService.name);

  constructor(
    private readonly config: ApiConfigService,
    private readonly producer: KafkaProducerService,
    @Optional()
    @Inject(KAFKA_CLIENT_OVERRIDES)
    private readonly overrides: KafkaClientOverrides = {},
  ) {}

  async redrive(
    consumer: string,
    options: { limit?: number } = {},
  ): Promise<RedriveResult> {
    const topic = deadLetterTopic(consumer);
    const kafka = createKafka(this.config, 'redrive', this.overrides);
    const admin = kafka.admin();
    await admin.connect();
    let end: number;
    try {
      const offsets = await admin.fetchTopicOffsets(topic);
      end = offsets.reduce((sum, o) => sum + Number(o.high), 0);
      const [committed] = await admin.fetchOffsets({
        groupId: `${consumer}.redrive`,
        topics: [topic],
      });
      const done = committed.partitions.reduce(
        (sum, p) => sum + Math.max(0, Number(p.offset)),
        0,
      );
      if (end === 0 || done >= end) return { redriven: 0, refused: 0 };
    } catch {
      return { redriven: 0, refused: 0 }; // no dead-letter topic: nothing to redrive
    } finally {
      await admin.disconnect();
    }

    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const result: RedriveResult = { redriven: 0, refused: 0 };
    const reader = kafka.consumer({
      groupId: `${consumer}.redrive`,
      maxWaitTimeInMs: 200,
    });
    await reader.connect();
    await reader.subscribe({ topic, fromBeginning: true });
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    await reader.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
        for (const message of batch.messages) {
          if (result.redriven + result.refused >= limit) {
            finished();
            return;
          }
          const header = (name: string) => {
            const v = message.headers?.[name];
            return v === undefined
              ? undefined
              : Buffer.isBuffer(v)
                ? v.toString()
                : String(v);
          };
          const count = Number(header('x-redrive-count') ?? 0);
          const source = header('x-source-topic');
          if (!source || count >= MAX_REDRIVES) {
            result.refused++;
            this.logger.warn(
              `dead letter ${topic}@${message.offset} not redriven (${source ? 'limit reached' : 'no source topic'})`,
            );
          } else {
            await this.producer.sendMany(source, [
              {
                key: message.key,
                value: message.value ?? Buffer.alloc(0),
                headers: { 'x-redrive-count': String(count + 1) },
              },
            ]);
            result.redriven++;
          }
          resolveOffset(message.offset);
          await reader.commitOffsets([
            {
              topic,
              partition: batch.partition,
              offset: (BigInt(message.offset) + 1n).toString(),
            },
          ]);
          await heartbeat();
          if (Number(message.offset) + 1 >= Number(batch.highWatermark)) {
            finished();
            return;
          }
        }
        if (Number(batch.lastOffset()) + 1 >= Number(batch.highWatermark))
          finished();
      },
    });
    await Promise.race([
      done,
      new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
    ]);
    await reader.disconnect();
    return result;
  }
}
