import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  channelName,
  type RealtimeMessage,
} from '@app/infrastructure/realtime';
import { firehoseTopic } from '../../domain/live-keys';
import type { LiveComment } from '../../domain/live-constants';
import type { CommentFeed } from '../../domain/live-ports';

/**
 * Publishes an accepted comment to the private feed the gateways read. Straight pub/sub (no replay stream): chat is
 * ephemeral, and a plain publish costs one command at 5,000 comments a second.
 */
@Injectable()
export class RedisCommentFeed implements CommentFeed {
  constructor(private readonly redis: RedisService) {}

  async publish(comment: LiveComment): Promise<void> {
    const topic = firehoseTopic(comment.streamId);
    const message: RealtimeMessage = {
      id: '0-0',
      topic,
      type: 'comment',
      data: comment,
    };
    await this.redis.client.publish(
      channelName(topic),
      JSON.stringify(message),
    );
  }
}
