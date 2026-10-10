import { Injectable, OnModuleInit } from '@nestjs/common';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { ShopAccessService } from '../application/shop-access.service';

/**
 * `shop:{shopId}:live` (SD-18 live sales dashboard, published by seller-insights): members of an `ACTIVE` or
 * `SUSPENDED` shop only (AS-83). The decision reads the database, not the cache: access to a stream must end with the
 * membership (S51 also closes subscriptions that are already open when `tenancy.member_removed` arrives).
 */
@Injectable()
export class ShopTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    private readonly access: ShopAccessService,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'shop',
      suffixes: ['live'],
      policy: async (viewer, _topic, shopId) => {
        if (!viewer.userId) return false;
        return this.access.mayFollowLiveTopic(shopId, viewer.userId);
      },
    });
  }
}

/** The routes this domain declares in the shared topic type (S51 FR-024). */
declare module '@app/infrastructure/realtime/topics' {
  interface RealtimeTopicPrefixes {
    'shop:live': `shop:${string}:live`;
  }
}
