import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ApiConfigService } from '@app/common/config';

@Injectable()
export class RedisPubSubService implements OnModuleDestroy {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

  constructor(private readonly configService: ApiConfigService) {
    const url = this.configService.get('redis_url');
    this.publisher = new Redis(url);
    this.subscriber = new Redis(url);
  }

  public async publish(channel: string, message: unknown): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(message));
  }

  public async subscribe(
    channel: string,
    onMessage: (message: string) => void,
  ): Promise<() => Promise<void>> {
    const handler = (receivedChannel: string, message: string) => {
      if (receivedChannel === channel) {
        onMessage(message);
      }
    };

    this.subscriber.on('message', handler);
    await this.subscriber.subscribe(channel);

    return async () => {
      this.subscriber.off('message', handler);
      await this.subscriber.unsubscribe(channel);
    };
  }

  async onModuleDestroy() {
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }
}
