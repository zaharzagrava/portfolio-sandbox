import { Injectable, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle/shutdown-registry.service';

/**
 * Shared command connection for rate limiting, caching, holds, leaderboards,
 * queues-in-Redis. Pub/sub keeps its own connections (a subscribed ioredis
 * connection can't issue normal commands).
 *
 * `enableAutoPipelining` batches concurrent commands issued in the same tick
 * into one round trip - a free throughput multiplier for hot paths that fire
 * many independent GET/INCRs per request.
 */
@Injectable()
export class RedisService {
  readonly client: Redis;

  constructor(
    config: ApiConfigService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    this.client = new Redis(config.get('redis_url'), {
      enableAutoPipelining: true,
      maxRetriesPerRequest: 2,
      // Fail fast instead of queueing commands forever while Redis is down - callers decide fail-open/closed.
      enableOfflineQueue: false,
      lazyConnect: false,
    });

    shutdown?.register({ name: 'redis.quit', order: 90, run: async () => void (await this.client.quit()) });
  }
}
