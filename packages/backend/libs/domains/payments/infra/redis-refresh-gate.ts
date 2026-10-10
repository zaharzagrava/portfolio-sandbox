import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { RefreshGate } from '../domain/ports';
import { withTimeout } from './with-timeout';

const REDIS_TIMEOUT_MS = 100;

/**
 * At most one provider refresh per payment per window across all instances (S13 research R-10):
 * `SET payments:refresh:<paymentId> 1 NX PX <ttl>`. A Redis outage or a slow answer means "do not refresh now", never an
 * error: the caller answers with the stored status.
 */
@Injectable()
export class RedisRefreshGate implements RefreshGate {
  private readonly logger = new Logger(RedisRefreshGate.name);

  constructor(private readonly redis: RedisService) {}

  async tryAcquire(paymentId: string, ttlMs: number): Promise<boolean> {
    try {
      const reply = await withTimeout(
        this.redis.client.set(
          `payments:refresh:${paymentId}`,
          '1',
          'PX',
          ttlMs,
          'NX',
        ),
        REDIS_TIMEOUT_MS,
        () => new Error('refresh gate timed out'),
      );
      return reply === 'OK';
    } catch (error) {
      this.logger.warn(`refresh gate unavailable: ${(error as Error).message}`);
      return false;
    }
  }
}
