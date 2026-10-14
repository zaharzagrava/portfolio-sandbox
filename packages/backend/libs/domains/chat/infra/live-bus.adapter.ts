import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  CHAT_MODERATION_REDIS_TOPIC,
  chatChannelRedisTopic,
} from '../domain/chat.constants';
import type { LiveBusPort } from '../domain/ports';

/**
 * The gateway-compatible buses (`chat:channel:<id>`, `chat:moderation`) the Rust chat-gateway subscribes to
 * (research R-08). The S51 publisher writes its own envelope to its own channels and cannot produce these message
 * formats, so this adapter is the only chat user of Redis `PUBLISH`. Receipts and presence go through the S51 hub.
 */
@Injectable()
export class LiveBusAdapter implements LiveBusPort {
  constructor(private readonly redis: RedisService) {}

  async publishChannel(
    channelId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    await this.redis.client.publish(
      chatChannelRedisTopic(channelId),
      JSON.stringify(event),
    );
  }

  async publishModeration(event: Record<string, unknown>): Promise<void> {
    await this.redis.client.publish(
      CHAT_MODERATION_REDIS_TOPIC,
      JSON.stringify(event),
    );
  }
}
