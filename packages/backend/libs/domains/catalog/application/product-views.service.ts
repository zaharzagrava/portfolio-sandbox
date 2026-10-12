import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { WriteBehindCounter } from '@app/infrastructure/cache';
import { TransactionRunner } from '@app/infrastructure/context';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { PRODUCT_VIEWS_COUNTER } from '../infra/product-cache';
import {
  VIEW_BATCH_REPOSITORY,
  type ViewBatchRepository,
} from '../domain/ports';
import { viewFlushCounter, viewFlushPending } from '../domain/product-metrics';

const LOG_INTERVAL_MS = 60_000;
export const VIEW_FLUSH_CHUNK = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * View counting (SD-34, README #22): a view is one O(1) increment in the shared hash, never a database write. A cache
 * outage loses the count, not the read: the failure is logged (rate limited) and counted, and the answer is unaffected.
 */
@Injectable()
export class ProductViewsService {
  private readonly logger = new Logger(ProductViewsService.name);
  private readonly counter: WriteBehindCounter;
  private lastLoggedMs = Number.NEGATIVE_INFINITY;

  constructor(
    redis: RedisService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: TransactionRunner,
    @Inject(VIEW_BATCH_REPOSITORY)
    private readonly batches: ViewBatchRepository,
  ) {
    this.counter = new WriteBehindCounter(redis, PRODUCT_VIEWS_COUNTER, {
      clock,
    });
  }

  /** Fire and forget: the reader never waits for the counter. */
  count(productId: string): void {
    this.counter.increment(productId).catch((error: Error) => {
      viewFlushCounter.add(1, { result: 'not_counted' });
      const now = this.clock.now().getTime();
      if (now - this.lastLoggedMs > LOG_INTERVAL_MS) {
        this.lastLoggedMs = now;
        this.logger.warn(`view not counted: ${error.message}`);
      }
    });
  }

  /**
   * Claims every pending count and adds it to `viewCount` in chunks of at most 1,000 products, each chunk in one
   * transaction together with its `(batchId, chunk)` marker. A failing chunk stops the flush: the chunks not yet
   * applied go back to the pending hash and the claim is committed, so applied chunks are never counted twice. If
   * even that restore fails the claim stays for `reclaimExpired`. Members that are not UUIDs are dropped and counted.
   */
  async flush(): Promise<void> {
    const { batchId, deltas } = await this.counter.claim();
    if (deltas.size === 0) {
      await this.counter.commit(batchId);
      return;
    }
    const entries: Array<[string, number]> = [];
    for (const [member, delta] of deltas) {
      if (UUID.test(member)) entries.push([member.toLowerCase(), delta]);
      else viewFlushCounter.add(1, { result: 'poison' });
    }
    entries.sort(([a], [b]) => (a < b ? -1 : 1));

    for (let start = 0; start < entries.length; start += VIEW_FLUSH_CHUNK) {
      const chunk = entries.slice(start, start + VIEW_FLUSH_CHUNK);
      try {
        const applied = await this.runner.run(() =>
          this.batches.applyChunk(
            batchId,
            start / VIEW_FLUSH_CHUNK,
            chunk.map(([id]) => id),
            chunk.map(([, delta]) => delta),
          ),
        );
        viewFlushCounter.add(1, { result: applied ? 'applied' : 'skipped' });
      } catch (error) {
        viewFlushCounter.add(1, { result: 'failed' });
        const unapplied = new Map(entries.slice(start));
        viewFlushPending.set(unapplied.size);
        try {
          await this.counter.restore(unapplied);
          await this.counter.commit(batchId);
        } catch (restoreError) {
          this.logger.error(
            `view flush ${batchId}: restore failed, claim left for reclaim: ${(restoreError as Error).message}`,
          );
        }
        this.logger.error(
          `view flush failed at chunk ${start / VIEW_FLUSH_CHUNK}, ${unapplied.size} deltas put back: ${(error as Error).message}`,
        );
        throw error;
      }
    }
    await this.counter.commit(batchId);
    viewFlushPending.set(0);
  }
}
