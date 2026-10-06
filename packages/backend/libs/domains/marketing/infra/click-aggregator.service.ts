import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { Consumer, EachBatchPayload, Producer } from 'kafkajs';
import { hostname } from 'node:os';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import { ADS_CLICKS_TOPIC, ClickRecord } from '../application/ads.service';

export const ADS_AGGREGATES_TOPIC = 'ads.click-aggregates';
const GROUP = 'ads-click-aggregator';

export interface MinuteAggregate {
  campaign_id: string;
  minute: string;
  source_partition: number;
  first_offset: number;
  clicks: number;
  invalid: number;
}

/** Pure: one Kafka batch → per (campaign, minute) counts, tagged with the batch identity (partition, first offset). */
export function aggregateBatch(partition: number, firstOffset: number, records: ClickRecord[]): MinuteAggregate[] {
  const byKey = new Map<string, MinuteAggregate>();
  for (const r of records) {
    const minute = `${r.ts.slice(0, 16)}:00`;
    const key = `${r.campaign_id}|${minute}`;
    const agg = byKey.get(key) ?? { campaign_id: r.campaign_id, minute, source_partition: partition, first_offset: firstOffset, clicks: 0, invalid: 0 };
    if (r.valid) agg.clicks++;
    else agg.invalid++;
    byKey.set(key, agg);
  }
  return [...byKey.values()];
}

/**
 * Exactly-once read-process-write with Kafka transactions (06/01 §2.2): the
 * aggregates for a batch AND the consumer offsets of that batch are committed
 * atomically. If the process dies mid-way, the transaction aborts - nothing
 * visible to read_committed readers - and the batch is re-read from the old
 * offset. Downstream rows are keyed by (campaign, minute, partition, first
 * offset), so even a non-transactional re-write would replace, not add.
 */
@Injectable()
export class ClickAggregator implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ClickAggregator.name);
  private consumer?: Consumer;
  private producer?: Producer;

  constructor(private readonly config: ApiConfigService) {}

  async onApplicationBootstrap() {
    const kafka = createKafka(this.config, 'ads-aggregator');
    this.producer = kafka.producer({ transactionalId: `${GROUP}-${hostname()}-${process.pid}`, idempotent: true, maxInFlightRequests: 1 });
    this.consumer = kafka.consumer({ groupId: GROUP, readUncommitted: false });
    try {
      await Promise.all([this.producer.connect(), this.consumer.connect()]);
      await this.consumer.subscribe({ topic: ADS_CLICKS_TOPIC, fromBeginning: false });
      void this.consumer.run({ autoCommit: false, eachBatch: (p) => this.onBatch(p) });
    } catch (error) {
      this.logger.warn(`ads aggregator not started: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.consumer?.disconnect();
    await this.producer?.disconnect();
  }

  private async onBatch({ batch, heartbeat }: EachBatchPayload) {
    if (batch.messages.length === 0) return;
    const records = batch.messages.flatMap((m) => {
      try {
        return [JSON.parse(m.value?.toString() ?? '') as ClickRecord];
      } catch {
        return [];
      }
    });
    const aggregates = aggregateBatch(batch.partition, Number(batch.messages[0].offset), records);
    const tx = await this.producer!.transaction();
    try {
      await tx.send({ topic: ADS_AGGREGATES_TOPIC, messages: aggregates.map((a) => ({ key: a.campaign_id, value: JSON.stringify(a) })) });
      await tx.sendOffsets({
        consumerGroupId: GROUP,
        topics: [{ topic: batch.topic, partitions: [{ partition: batch.partition, offset: (BigInt(batch.lastOffset()) + 1n).toString() }] }],
      });
      await tx.commit();
    } catch (error) {
      await tx.abort();
      throw error; // kafkajs re-delivers the batch from the last committed offset
    }
    await heartbeat();
  }
}
