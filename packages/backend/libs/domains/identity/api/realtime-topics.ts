import { Injectable, OnModuleInit } from '@nestjs/common';
import { TopicRegistry } from '@app/infrastructure/realtime/topic-registry';

/** `user:{userId}`: a user's private channel (notifications, order updates). Only that user. */
@Injectable()
export class IdentityTopics implements OnModuleInit {
  constructor(private readonly topics: TopicRegistry) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'user',
      policy: (viewer, _topic, userId) => viewer.userId === userId,
    });
  }
}
