import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { RingRegistry } from '../domain/delivery-ports';
import { RING_KEY } from './courier-keys';

/** An instance that has not beaten for this long is gone (S20 R-8). */
export const HEARTBEAT_EXPIRY_MS = 30_000;
const COMMAND_TIMEOUT_MS = 1_000;

const withTimeout = <T>(work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('ring registry timed out')),
        COMMAND_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * The live dispatcher instances in one global Redis hash (S20 R-8, A25): field = instance id, value = the epoch ms of its
 * last heartbeat, taken from the caller's clock. An instance is live while its last beat is at most 30 s old, so the
 * answer is a function of the arguments, not of the store's clock; the hash itself expires a minute after the last beat,
 * so an idle fleet leaves nothing behind. Expired fields are removed by whoever reads them (best effort).
 */
@Injectable()
export class RedisRingRegistry implements RingRegistry {
  constructor(private readonly redis: RedisService) {}

  async heartbeat(instanceId: string, now: number): Promise<void> {
    await withTimeout(
      this.redis.client
        .multi()
        .hset(RING_KEY, instanceId, String(now))
        .expire(RING_KEY, (HEARTBEAT_EXPIRY_MS * 2) / 1000)
        .exec(),
    );
  }

  async leave(instanceId: string): Promise<void> {
    await withTimeout(this.redis.client.hdel(RING_KEY, instanceId));
  }

  async liveInstances(now: number): Promise<string[]> {
    const beats = await withTimeout(this.redis.client.hgetall(RING_KEY));
    const live: string[] = [];
    const expired: string[] = [];
    for (const [instance, beat] of Object.entries(beats)) {
      const age = now - Number(beat);
      if (Number.isFinite(age) && age <= HEARTBEAT_EXPIRY_MS)
        live.push(instance);
      else expired.push(instance);
    }
    if (expired.length > 0)
      void this.redis.client.hdel(RING_KEY, ...expired).catch(() => undefined);
    return live.sort();
  }
}
