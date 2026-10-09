import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  channelName,
  REPLAY_MAXLEN,
  RealtimeMessage,
  RealtimeTopic,
  streamKey,
} from './topics';

/**
 * Domain code calls `publish(topic, type, data)`; gateways deliver it to every
 * subscribed connection on any instance. XADD (capped, approximate trim)
 * gives reconnecting clients a replay window; PUBLISH is the live path.
 * Both go in one MULTI so a live subscriber never sees an id that isn't in
 * the replay stream yet.
 */
@Injectable()
export class RealtimePublisher {
  constructor(private readonly redis: RedisService) {}

  async publish<T>(
    topic: RealtimeTopic,
    type: string,
    data: T,
    { replay = true } = {},
  ): Promise<string> {
    if (!replay) {
      const message: RealtimeMessage<T> = { id: '0-0', topic, type, data };
      await this.redis.client.publish(
        channelName(topic),
        JSON.stringify(message),
      );
      return message.id;
    }

    const id = (await this.redis.client.xadd(
      streamKey(topic),
      'MAXLEN',
      '~',
      String(REPLAY_MAXLEN),
      '*',
      'type',
      type,
      'data',
      JSON.stringify(data),
    ))!;
    const message: RealtimeMessage<T> = { id, topic, type, data };
    await this.redis.client.publish(
      channelName(topic),
      JSON.stringify(message),
    );
    return id;
  }
}
