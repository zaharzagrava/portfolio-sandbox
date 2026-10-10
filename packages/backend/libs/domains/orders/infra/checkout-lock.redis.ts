import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { CheckoutLock } from '../domain/ports';
import { CheckoutUnavailableError } from '../domain/order-errors';
import { withTimeout } from './with-timeout';

const LOCK_TTL_MS = 15_000;
/** Deletes the key only when it still holds our token (a lock that expired and was retaken is not ours). */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * One checkout per buyer at a time (S10 FR-024): `SET orders:checkout-lock:<userId> <token> NX PX 15000`. A Redis
 * outage or a slow answer refuses the checkout (503): a lock that cannot be taken is not silently skipped.
 */
@Injectable()
export class RedisCheckoutLock implements CheckoutLock {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
  ) {}

  private key = (userId: string) => `orders:checkout-lock:${userId}`;

  async acquire(userId: string): Promise<string | null> {
    const token = randomUUID();
    try {
      const reply = await withTimeout(
        this.redis.client.set(this.key(userId), token, 'PX', LOCK_TTL_MS, 'NX'),
        this.config.get('orders_lock_timeout_ms'),
        () => new CheckoutUnavailableError(),
      );
      return reply === 'OK' ? token : null;
    } catch (error) {
      if (error instanceof CheckoutUnavailableError) throw error;
      throw new CheckoutUnavailableError();
    }
  }

  async release(userId: string, token: string): Promise<void> {
    try {
      await this.redis.client.eval(RELEASE, 1, this.key(userId), token);
    } catch {
      // the lock expires on its own after 15 s
    }
  }
}
