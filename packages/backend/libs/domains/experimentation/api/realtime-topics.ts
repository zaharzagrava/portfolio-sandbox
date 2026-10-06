import { Injectable, OnModuleInit } from '@nestjs/common';
import { TopicRegistry } from '@app/infrastructure/realtime/topic-registry';

/** `flags`: feature-flag ruleset changes for services (SD-38). */
@Injectable()
export class FlagTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
  ) {}

  onModuleInit() {
    this.topics.define({ prefix: 'flags', singleton: true, policy: (viewer) => viewer.roles?.includes('SERVICE') ?? false });
  }
}
