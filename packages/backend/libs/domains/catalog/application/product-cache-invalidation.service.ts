import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '@app/infrastructure/cache';
import { afterCommit, getActiveTransaction } from '@app/infrastructure/context';
import { productCacheKey } from '../infra/product-cache';
import { productInvalidationCounter } from '../domain/product-metrics';

const CONCURRENCY = 20;

export interface InvalidationTarget {
  productId: string;
  /** The product version the change produced: entries older than it are dropped and the minimum is raised to it. */
  version: number;
}

/**
 * Writer-side and event-side invalidation in one place (A11): delete the entry of a changed product and raise its
 * minimum accepted version, so a slow reader that loaded the old row cannot put it back (AS-43). A failure is logged
 * and counted, never thrown: the write already committed, and the event-driven invalidator repairs the entry (AS-40).
 */
@Injectable()
export class ProductCacheInvalidation {
  private readonly logger = new Logger(ProductCacheInvalidation.name);

  constructor(private readonly cache: CacheService) {}

  /**
   * After the surrounding transaction commits (immediately when there is none), awaited by the caller when it is the
   * outermost scope so the entry is gone before the response is sent.
   */
  async afterWrite(targets: InvalidationTarget[]): Promise<void> {
    if (targets.length === 0) return;
    if (getActiveTransaction()) {
      afterCommit(() => this.invalidate(targets));
      return;
    }
    await this.invalidate(targets);
  }

  async invalidate(targets: InvalidationTarget[]): Promise<void> {
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const chunk = targets.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map((target) => this.one(target)));
    }
  }

  private async one(target: InvalidationTarget): Promise<void> {
    try {
      const { outcome } = await this.cache.invalidateIfOlder(
        productCacheKey(target.productId),
        target.version,
      );
      productInvalidationCounter.add(1, { result: outcome });
    } catch (error) {
      productInvalidationCounter.add(1, { result: 'failed' });
      this.logger.warn(
        `cache invalidation failed for product ${target.productId}: ${(error as Error).message}`,
      );
    }
  }
}
