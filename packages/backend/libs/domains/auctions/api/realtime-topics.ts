import { Injectable, OnModuleInit } from '@nestjs/common';
import { TopicRegistry } from '@app/infrastructure/realtime/topic-registry';

/** `auction:{auctionId}`: public price ticker (SD-22). */
@Injectable()
export class AuctionTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
  ) {}

  onModuleInit() {
    this.topics.define({ prefix: 'auction', policy: () => true });
  }
}
