import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { BuildLock } from '../domain/recommendation-ports';
import { BUILD_LOCK_KEY } from './recommendation-keys';

/** The lease of the lock equals the job lease: a holder that crashes is outlived by it (S34 R-8). */
export const BUILD_LOCK_LEASE_MS = 3_600_000;

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/** `SET NX PX` with an owner token; release deletes only the caller's own token. */
@Injectable()
export class RedisBuildLockAdapter implements BuildLock {
  constructor(private readonly redis: RedisService) {}

  async acquire(): Promise<string | null> {
    const token = randomUUID();
    const reply = await this.redis.client.set(
      BUILD_LOCK_KEY,
      token,
      'PX',
      BUILD_LOCK_LEASE_MS,
      'NX',
    );
    return reply === 'OK' ? token : null;
  }

  async release(token: string): Promise<void> {
    await this.redis.client.eval(RELEASE, 1, BUILD_LOCK_KEY, token);
  }
}
