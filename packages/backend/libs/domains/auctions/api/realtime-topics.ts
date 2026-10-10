import { Injectable, OnModuleInit } from '@nestjs/common';
import { TopicRegistry } from '@app/infrastructure/realtime';

/** `auction:{auctionId}`: public price ticker (SD-22). */
@Injectable()
export class AuctionTopics implements OnModuleInit {
  constructor(private readonly topics: TopicRegistry) {}

  onModuleInit() {
    this.topics.define({ prefix: 'auction', policy: () => true });
  }
}

/** The routes this domain declares in the shared topic type (S51 FR-024). */
declare module '@app/infrastructure/realtime/topics' {
  interface RealtimeTopicPrefixes {
    auction: `auction:${string}`;
  }
}
