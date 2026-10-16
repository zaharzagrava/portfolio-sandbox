import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { PositionThrottle } from '../domain/delivery-ports';
import { errorText, logDelivery } from '../application/delivery-log';
import { trackThrottleKey } from './courier-keys';

const COMMAND_TIMEOUT_MS = 500;

/**
 * KEYS[1] throttle key. ARGV: now (epoch ms), window (ms). Claims when nothing was claimed within the last window
 * (strictly more than the window since the last claim). The comparison uses the caller's clock, never the store's, so a
 * frozen clock gives a deterministic answer; the key's own expiry (twice the window) only cleans up.
 */
export const CLAIM_PUSH = `
local last = tonumber(redis.call('GET', KEYS[1]) or '')
if last and tonumber(ARGV[1]) - last <= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]) * 2)
return 1`;

/**
 * The per-delivery position push limiter in Redis (S20 FR-040, A26): the key carries the `{city}` hash tag like every
 * other per-city key. A store fault means "no push" - the position is live data and the next ping tries again.
 */
@Injectable()
export class RedisPositionThrottle implements PositionThrottle {
  private readonly logger = new Logger(RedisPositionThrottle.name);

  constructor(private readonly redis: RedisService) {}

  async claim(
    city: string,
    deliveryId: string,
    now: number,
    windowMs: number,
  ): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const claimed = await Promise.race([
        this.redis.client.eval(
          CLAIM_PUSH,
          1,
          trackThrottleKey(city, deliveryId),
          now,
          windowMs,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('position throttle timed out')),
            COMMAND_TIMEOUT_MS,
          );
        }),
      ]);
      return claimed === 1;
    } catch (error) {
      logDelivery(this.logger, 'warn', 'delivery.throttle_failed', {
        deliveryId,
        city,
        error: errorText(error),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
