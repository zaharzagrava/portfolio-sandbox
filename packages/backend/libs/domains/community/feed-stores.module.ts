import { Module } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  ANNOUNCEMENT_STORE,
  CELEBRITY_STORE,
  FEED_CURSOR_CODEC,
  FEED_ITEM_STORE,
  FEED_RANDOM_BYTES,
  FEED_REDIS_CLIENT,
  FEED_SCYLLA_CLIENT,
  FOLLOW_CACHE_INVALIDATOR,
  FOLLOW_GRAPH_STORE,
  LEGACY_KEY_CLEANER,
  PRODUCT_COPY_STORE,
  TIMELINE_STORE,
} from './domain/ports';
import { cryptoRandomBytes, hmacFeedCursorCodec } from './infra/crypto-support';
import { FeedScylla } from './infra/feed-scylla';
import { RedisTimelineStore } from './infra/redis-timeline.store';
import {
  RedisFollowCache,
  RedisLegacyKeyCleaner,
} from './infra/redis-follow-cache';
import { ScyllaAnnouncementStore } from './infra/scylla-announcement.store';
import { ScyllaCelebrityStore } from './infra/scylla-celebrity.store';
import { ScyllaFeedItemStore } from './infra/scylla-feed-item.store';
import { ScyllaFollowStore } from './infra/scylla-follow.store';
import { ScyllaProductCopyStore } from './infra/scylla-product-copy.store';

/**
 * Everything the follow graph and the feed keep in their own stores: the ScyllaDB and Redis driver edges and the
 * adapters bound to the ports of `domain/ports.ts`. Shared by the HTTP side (`FeedModule`), the projectors
 * (`FeedProjectorsModule`) and the jobs (`FeedWorkerModule`), so none owns a second copy of a provider (mirrors
 * `DiscussionsStoresModule`, L-018).
 *
 * The follow graph (`FOLLOW_GRAPH_STORE`, `FOLLOW_CACHE_INVALIDATOR`, `LEGACY_KEY_CLEANER`), the items
 * (`FEED_ITEM_STORE`, `PRODUCT_COPY_STORE`, `ANNOUNCEMENT_STORE`), the timeline cache (`TIMELINE_STORE`) and celebrity
 * status (`CELEBRITY_STORE`). The anti-corruption adapters over other domains' R1 services (`FEED_SHOP_DIRECTORY`,
 * `FEED_ACCOUNT_DIRECTORY`, `FEED_POST_LOOKUP`) are bound by the module that imports those domains (`FeedModule`), as S25
 * does, so the stores stay free of identity, tenancy and discussions.
 */
const PORTS = [
  FEED_CURSOR_CODEC,
  FEED_RANDOM_BYTES,
  FOLLOW_GRAPH_STORE,
  FOLLOW_CACHE_INVALIDATOR,
  LEGACY_KEY_CLEANER,
  FEED_ITEM_STORE,
  PRODUCT_COPY_STORE,
  ANNOUNCEMENT_STORE,
  TIMELINE_STORE,
  CELEBRITY_STORE,
];

@Module({
  imports: [CassandraModule],
  providers: [
    {
      provide: FEED_SCYLLA_CLIENT,
      inject: [CassandraService],
      useFactory: (cassandra: CassandraService) => cassandra.client,
    },
    {
      provide: FEED_REDIS_CLIENT,
      inject: [RedisService],
      useFactory: (redis: RedisService) => redis.client,
    },
    {
      provide: FEED_CURSOR_CODEC,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) =>
        hmacFeedCursorCodec(config.get('feed_cursor_secret')),
    },
    { provide: FEED_RANDOM_BYTES, useValue: cryptoRandomBytes },
    FeedScylla,
    { provide: FEED_ITEM_STORE, useClass: ScyllaFeedItemStore },
    { provide: PRODUCT_COPY_STORE, useClass: ScyllaProductCopyStore },
    { provide: ANNOUNCEMENT_STORE, useClass: ScyllaAnnouncementStore },
    { provide: TIMELINE_STORE, useClass: RedisTimelineStore },
    { provide: CELEBRITY_STORE, useClass: ScyllaCelebrityStore },
    { provide: FOLLOW_GRAPH_STORE, useClass: ScyllaFollowStore },
    { provide: FOLLOW_CACHE_INVALIDATOR, useClass: RedisFollowCache },
    { provide: LEGACY_KEY_CLEANER, useClass: RedisLegacyKeyCleaner },
  ],
  exports: [...PORTS, FEED_SCYLLA_CLIENT, FEED_REDIS_CLIENT, FeedScylla],
})
export class FeedStoresModule {}
