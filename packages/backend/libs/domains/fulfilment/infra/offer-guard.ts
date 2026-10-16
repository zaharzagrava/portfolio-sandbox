import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { OfferGuard } from '../domain/delivery-ports';
import { offerLockKey } from './courier-keys';

/** Every Redis call of the guard gives up after this long; the store of record decides anyway. */
const GUARD_TIMEOUT_MS = 500;

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

const withTimeout = <T>(work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('offer guard timed out')),
        GUARD_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * The cheap pre-guard in front of the offer insert (S20 R-1): `SET NX PX` on the courier's offer key under the `{city}`
 * tag, so two dispatchers rarely even try to offer the same courier. It is an optimisation only: a refused `SET` skips
 * the courier, but a Redis fault or timeout answers "go ahead", because the unique index on `DeliveryOffer` is what
 * guarantees one live offer per courier (AS-21, AS-22).
 */
@Injectable()
export class RedisOfferGuard implements OfferGuard {
  private readonly logger = new Logger(RedisOfferGuard.name);

  constructor(private readonly redis: RedisService) {}

  async tryAcquire(
    city: string,
    courierId: string,
    deliveryId: string,
    ttlMs: number,
  ): Promise<boolean> {
    try {
      const reply = await withTimeout(
        this.redis.client.set(
          offerLockKey(city, courierId),
          deliveryId,
          'PX',
          ttlMs,
          'NX',
        ),
      );
      return reply === 'OK';
    } catch (error) {
      this.logger.warn(`offer guard unavailable: ${(error as Error).message}`);
      return true;
    }
  }

  async release(
    city: string,
    courierId: string,
    deliveryId: string,
  ): Promise<void> {
    try {
      await withTimeout(
        this.redis.client.eval(
          RELEASE,
          1,
          offerLockKey(city, courierId),
          deliveryId,
        ),
      );
    } catch (error) {
      // The key expires on its own.
      this.logger.warn(`offer guard not released: ${(error as Error).message}`);
    }
  }
}
