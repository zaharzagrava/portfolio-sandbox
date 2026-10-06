import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ApiConfigService } from '@app/common/config/api-config.service';

/**
 * Shared Redis pub/sub client. NestJS-side publishers only need `publish` -
 * the actual fan-out to connected clients happens in the Rust chat-gateway,
 * which subscribes to these same channels.
 */
@Injectable()
export class RedisPubSubService implements OnModuleDestroy {
  private readonly publisher: Redis;

  constructor(private readonly configService: ApiConfigService) {
    const url = this.configService.get('redis_url');
    this.publisher = new Redis(url);
  }

  public async publish(channel: string, message: unknown): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(message));
  }

  async onModuleDestroy() {
    this.publisher.disconnect();
  }
}
