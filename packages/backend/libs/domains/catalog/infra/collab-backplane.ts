import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ApiConfigService } from '@app/common/config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { parseBackplaneMessage } from '../domain/backplane-message';
import { DRAFT_LIMITS } from '../domain/draft-limits';
import type { Backplane, BackplaneMessage } from '../domain/draft-ports';
import { bestEffort } from './timeouts';
import { shardName } from '@app/common/shard';

export const COLLAB_REVOKE_CHANNEL = shardName('collab:revoke');

/**
 * Instant notification between processes over Redis pub/sub (S06 D-6). Best effort: a publish that fails or takes longer
 * than 250 ms is dropped, because the 60 second membership re-check carries the guarantee. The subscriber has its own
 * connection (a subscribed connection cannot run other commands).
 */
@Injectable()
export class RedisBackplane implements Backplane, OnModuleDestroy {
  private readonly logger = new Logger(RedisBackplane.name);
  private subscriber?: Redis;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
  ) {}

  async publish(message: BackplaneMessage): Promise<void> {
    await bestEffort('backplane publish', DRAFT_LIMITS.redisTimeoutMs, () =>
      this.redis.client.publish(COLLAB_REVOKE_CHANNEL, JSON.stringify(message)),
    );
  }

  async subscribe(handler: (message: BackplaneMessage) => void): Promise<void> {
    this.subscriber = new Redis(this.config.get('redis_url'), {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('message', (_channel: string, raw: string) => {
      const message = parseBackplaneMessage(raw);
      if (message) handler(message);
      else this.logger.warn('backplane message dropped: not a known message');
    });
    try {
      await this.subscriber.connect();
      await this.subscriber.subscribe(COLLAB_REVOKE_CHANNEL);
    } catch {
      this.logger.warn(
        'backplane channel unavailable; the re-check still applies',
      );
    }
  }

  close(): Promise<void> {
    this.subscriber?.disconnect();
    this.subscriber = undefined;
    return Promise.resolve();
  }

  async onModuleDestroy() {
    await this.close();
  }
}
