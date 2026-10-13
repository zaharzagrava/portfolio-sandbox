import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { ApiConfigService } from '@app/common/config';
import { CacheUnavailableError, REDIS_CLIENT } from '../domain/ports';

/**
 * Every Redis call of discussions goes through here: explicit timeout (FR-071), failures logged by class only and
 * raised as `CacheUnavailableError`. The client is injected under `REDIS_CLIENT` so a spec can put a switchable fault
 * in front of it (AS-51) without touching the rate limiter or idempotency, which use the shared client.
 */
@Injectable()
export class RedisGuard {
  private readonly logger = new Logger(RedisGuard.name);

  constructor(
    @Inject(REDIS_CLIENT) readonly client: Redis,
    private readonly config: ApiConfigService,
  ) {}

  async run<T>(call: (client: Redis) => Promise<T>): Promise<T> {
    const timeoutMs = this.config.get('discussions_redis_timeout_ms');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        call(this.client),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
    } catch (error) {
      this.logger.warn(`cache call failed cause=${(error as Error).name}`);
      throw new CacheUnavailableError();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
