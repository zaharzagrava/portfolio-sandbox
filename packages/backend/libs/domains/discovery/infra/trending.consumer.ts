import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { Consumer, EachBatchPayload } from 'kafkajs';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import { ANALYTICS_TOPIC } from '@app/domains/experimentation';
import { CountMinSketch, TopK, TumblingWindows } from '../domain/count-min-sketch';

export const WINDOW_MS = 60_000;
const ALLOWED_LATENESS_MS = 120_000;
const PER_CATEGORY_K = 50;
const WEIGHTS: Record<string, number> = { product_view: 1, add_to_cart: 5 };
export const windowKey = (category: string, windowStart: number) => `trending:{${category}}:${windowStart}`;

interface WindowState {
  sketches: Map<string, { cms: CountMinSketch; top: TopK }>;
}

/**
 * Raw analytics stream → per-category heavy hitters per 1-minute window
 * (10/09 #32). One instance per consumer-group member; each holds sketches
 * only for ITS partitions. On window close, its partial top-50 per category is
 * ZINCRBY-merged into a shared Redis window ZSET - the multi-level merge
 * (partition-level top-K → global) happens in Redis.
 * Offsets are committed as consumed, so a crash LOSES the still-open windows
 * (≤ 3 minutes of counts) instead of double counting them - acceptable for an
 * approximate "trending" list; money (ad clicks) uses the exact,
 * transactional path in ads/ instead.
 */
@Injectable()
export class TrendingConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TrendingConsumer.name);
  private readonly windows = new TumblingWindows<WindowState>(WINDOW_MS, ALLOWED_LATENESS_MS, () => ({ sketches: new Map() }));
  private consumer?: Consumer;

  constructor(
    private readonly config: ApiConfigService,
    private readonly redis: RedisService,
  ) {}

  async onApplicationBootstrap() {
    this.consumer = createKafka(this.config, 'trending').consumer({ groupId: 'trending-topk', maxBytesPerPartition: 4 * 1024 * 1024 });
    await this.consumer.connect().catch((e) => this.logger.warn(`kafka unavailable: ${e.message}`));
    await this.consumer.subscribe({ topic: ANALYTICS_TOPIC, fromBeginning: false }).catch(() => undefined);
    void this.consumer.run({ autoCommit: false, eachBatch: (payload) => this.onBatch(payload) }).catch((e) => this.logger.error(e.message));
  }

  async onModuleDestroy() {
    await this.flush(true);
    await this.consumer?.disconnect();
  }

  async onBatch({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }: Pick<EachBatchPayload, 'batch' | 'resolveOffset' | 'heartbeat' | 'commitOffsetsIfNecessary'>) {
    for (const message of batch.messages) {
      try {
        this.ingest(JSON.parse(message.value?.toString() ?? '{}'));
      } catch {
        /* malformed rows are the ClickHouse error stream's business */
      }
      resolveOffset(message.offset);
    }
    await this.flush();
    await commitOffsetsIfNecessary();
    await heartbeat();
  }

  ingest(e: { name?: string; ts?: string; props?: Record<string, string> }) {
    const weight = WEIGHTS[e.name ?? ''];
    const productId = e.props?.product_id;
    if (!weight || !productId || !e.ts) return;
    const state = this.windows.stateFor(Date.parse(`${e.ts.replace(' ', 'T')}Z`));
    if (!state) return;
    for (const category of ['all', e.props?.category].filter((c): c is string => !!c)) {
      let s = state.sketches.get(category);
      if (!s) {
        s = { cms: new CountMinSketch(1 << 14, 4), top: new TopK(PER_CATEGORY_K) };
        state.sketches.set(category, s);
      }
      s.top.offer(productId, s.cms.add(productId, weight));
    }
  }

  async flush(all = false): Promise<number> {
    const closed = this.windows.closeReady(all);
    for (const { start, state } of closed) {
      const pipeline = this.redis.client.pipeline();
      for (const [category, { top }] of state.sketches) {
        const key = windowKey(category, start);
        for (const { key: productId, count } of top.top()) pipeline.zincrby(key, count, productId);
        pipeline.expire(key, 2 * 3600);
      }
      await pipeline.exec();
    }
    return closed.length;
  }
}
