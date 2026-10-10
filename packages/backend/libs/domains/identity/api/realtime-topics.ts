import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  StreamAuthenticatorRegistry,
  TopicRegistry,
} from '@app/infrastructure/realtime';
import { IdentityStreamAuthenticator } from './realtime-authenticator';

/**
 * `user:{userId}`: a user's private channel (notifications, order updates). Only that user. Also registers the
 * credential check the stream endpoint uses (S51 FR-010).
 */
@Injectable()
export class IdentityTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    private readonly authenticator: StreamAuthenticatorRegistry,
    private readonly identity: IdentityStreamAuthenticator,
  ) {}

  onModuleInit() {
    this.authenticator.register(this.identity);
    this.topics.define({
      prefix: 'user',
      owner: 'identity',
      policy: (viewer, _topic, userId) => viewer.userId === userId,
    });
  }
}

/** The routes this domain declares in the shared topic type (S51 FR-024). */
declare module '@app/infrastructure/realtime/topics' {
  interface RealtimeTopicPrefixes {
    user: `user:${string}`;
  }
}
