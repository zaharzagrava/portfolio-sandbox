import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { WriteBehindCounter } from '@app/infrastructure/cache';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { PRODUCT_VIEWS_COUNTER } from '../infra/product-cache';
import { viewFlushCounter } from '../domain/product-metrics';

const LOG_INTERVAL_MS = 60_000;

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
}
