import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import {
  KAFKA_CONSUMER_OVERRIDES,
  type KafkaClientOverrides,
} from '@app/infrastructure/kafka/kafka-client.options';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { ProductCreated } from '@app/domains/catalog';
import { ProductProjectionService, type ReplayLedger } from '../projection/product-projection.service';

const TOPIC = ProductCreated.topic;
/** Events applied (and offsets committed) per step; a crash loses at most one step of work. */
const CHUNK = 200;

export interface ReplayPosition {
  /** Next offset to read per partition (what the run's own consumer group has committed). */
  next: Record<string, number>;
  /** End offsets when the run started building: the replay stops there; the live projector covers what follows. */
  watermark: Record<string, number>;
}

export interface ReplayHooks {
  /** Called after each applied step with its number; throws to stop (crash) or returns `false` to stop quietly. */
  afterChunk(step: number, position: ReplayPosition): Promise<boolean>;
}

/**
 * Reads the retained `products.events` with a consumer group of the run (`search-reindex-<runId>`) from the beginning
 * up to the end offsets captured when the run began, and applies it to the index being built (R-07). The group's
 * committed offsets are the resume position: a worker that takes the run over continues from them.
 */
@Injectable()
export class HistoryReplayService {
  private readonly logger = new Logger(HistoryReplayService.name);

  constructor(
    private readonly config: ApiConfigService,
    private readonly projection: ProductProjectionService,
    @Optional()
    @Inject(KAFKA_CONSUMER_OVERRIDES)
    private readonly overrides: KafkaClientOverrides = {},
  ) {}

  static groupOf(runId: string): string {
    return `search-reindex-${runId}`;
  }

  /** The end offsets now: the point the replay will stop at. */
  async captureWatermark(): Promise<Record<string, number>> {
    const admin = createKafka(this.config, 'search-reindex', this.overrides).admin();
    await admin.connect();
    try {
      const offsets = await admin.fetchTopicOffsets(TOPIC).catch(() => []);
      return Object.fromEntries(offsets.map((o) => [String(o.partition), Number(o.high)]));
    } finally {
      await admin.disconnect();
    }
  }

  async replay(
    runId: string,
    target: { index: string; reuseVectors: boolean },
    watermark: Record<string, number>,
    hooks: ReplayHooks,
    initial: ReplayLedger,
  ): Promise<{ ledger: ReplayLedger; position: ReplayPosition; stopped: boolean }> {
    const ledger = { ...initial };
    const group = HistoryReplayService.groupOf(runId);
    const kafka = createKafka(this.config, 'search-reindex', this.overrides);
    const admin = kafka.admin();
    await admin.connect();

    // partitions that have nothing to read below their watermark are done before we start
    const committed = new Map<number, number>();
    try {
      const [fetched] = await admin
        .fetchOffsets({ groupId: group, topics: [TOPIC] })
        .catch(() => []);
      for (const p of fetched?.partitions ?? [])
        if (Number(p.offset) >= 0) committed.set(p.partition, Number(p.offset));
    } catch {
      // a group that never committed has no offsets
    }
    const lowOffsets = await admin.fetchTopicOffsets(TOPIC).catch(() => []);
    const low = new Map<number, number>(
      lowOffsets.map((o) => [o.partition, Number(o.low)] as [number, number]),
    );
    const pending = new Set<number>();
    const next: Record<string, number> = {};
    for (const [partition, end] of Object.entries(watermark)) {
      const from: number =
        committed.get(Number(partition)) ?? low.get(Number(partition)) ?? 0;
      next[partition] = from;
      if (from < end) pending.add(Number(partition));
    }
    const position = (): ReplayPosition => ({ next: { ...next }, watermark });
    if (pending.size === 0) {
      await admin.disconnect();
      return { ledger, position: position(), stopped: false };
    }

    const consumer = kafka.consumer({
      groupId: group,
      sessionTimeout: 60_000,
      heartbeatInterval: 3_000,
      maxBytesPerPartition: 1024 * 1024,
    });
    let step = 0;
    let stopped = false;
    let failure: unknown = null;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });

    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale }) => {
        const end = watermark[String(batch.partition)] ?? 0;
        const messages = batch.messages.filter(
          (m) => Number(m.offset) < end && m.value !== null,
        );
        const lastSeen = batch.messages.length
          ? Number(batch.messages[batch.messages.length - 1].offset)
          : -1;
        try {
          for (let i = 0; i < messages.length; i += CHUNK) {
            if (!isRunning() || isStale() || stopped || failure) return;
            const chunk = messages.slice(i, i + CHUNK);
            const events = chunk.map(
              (m) => JSON.parse(m.value!.toString('utf8')) as EventEnvelope,
            );
            const part = await this.projection.replay(events, target);
            for (const key of ['read', 'applied', 'duplicate', 'stale', 'ignored'] as const)
              ledger[key] += part[key];
            const lastOffset = Number(chunk[chunk.length - 1].offset);
            resolveOffset(String(lastOffset));
            next[String(batch.partition)] = lastOffset + 1;
            await commitOffsetsIfNecessary();
            await heartbeat();
            step++;
            if (!(await hooks.afterChunk(step, position()))) {
              stopped = true;
              finish();
              return;
            }
          }
          // compaction can leave no message at the very end of the range: the batch reaching the end settles it
          if (lastSeen >= end - 1 || batch.messages.length === 0 || messages.length === 0) {
            if (lastSeen >= end - 1 || batch.offsetLag() === '0') {
              next[String(batch.partition)] = end;
              pending.delete(batch.partition);
            }
          }
          if (messages.length > 0 && next[String(batch.partition)] >= end)
            pending.delete(batch.partition);
          if (pending.size === 0) finish();
        } catch (error) {
          failure = error;
          finish();
        }
      },
    });

    await done;
    await consumer.stop().catch(() => undefined);
    await consumer.disconnect().catch(() => undefined);
    if (!stopped && !failure) {
      // the run's group has served its purpose; its offsets are not a state anyone needs to keep
      await admin.deleteGroups([group]).catch(() => undefined);
    }
    await admin.disconnect();
    if (failure) throw failure;
    this.logger.log({ action: 'search.reindex.replayed', runId, ...ledger });
    return { ledger, position: position(), stopped };
  }
}
