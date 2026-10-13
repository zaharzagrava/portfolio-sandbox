import { Module } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CountsService } from './application/counts.service';
import { DiscussionIds } from './application/discussion-support';
import { DiscussionQueryService } from './application/discussion-query.service';
import { RankingService } from './application/ranking.service';
import { ViewService } from './application/view.service';
import {
  ANOMALY_TRACKER,
  CLAIM_STORE,
  COMMENT_STORE,
  COUNT_CACHE,
  COUNT_STORE,
  CURSOR_CODEC,
  EVENT_STORE,
  PAGE_CACHE,
  POST_STORE,
  RANDOM_BYTES,
  RANK_CACHE,
  REDIS_CLIENT,
  SCYLLA_CLIENT,
  SHADOW_STORE,
  VOTE_DELTA_BUFFER,
  VOTE_STORE,
} from './domain/ports';
import { cryptoRandomBytes, hmacCursorCodec } from './infra/crypto-support';
import { RedisAnomalyTracker } from './infra/redis-anomaly.tracker';
import { RedisCountCache } from './infra/redis-count.cache';
import { RedisGuard } from './infra/redis-guard';
import { RedisPageCache } from './infra/redis-page.cache';
import { RedisRankingCache } from './infra/redis-ranking.cache';
import { RedisVoteDeltaBuffer } from './infra/redis-vote-delta.buffer';
import { ScyllaClaimStore } from './infra/scylla-claim.store';
import { ScyllaCommentStore } from './infra/scylla-comment.store';
import { ScyllaCountStore } from './infra/scylla-count.store';
import { ScyllaEventStore } from './infra/scylla-event.store';
import { ScyllaPostStore } from './infra/scylla-post.store';
import { ScyllaShadowStore } from './infra/scylla-shadow.store';
import { ScyllaStore } from './infra/scylla-store';
import { ScyllaVoteStore } from './infra/scylla-vote.store';

const PORTS = [
  POST_STORE,
  COMMENT_STORE,
  VOTE_STORE,
  CLAIM_STORE,
  EVENT_STORE,
  SHADOW_STORE,
  COUNT_STORE,
  COUNT_CACHE,
  RANK_CACHE,
  PAGE_CACHE,
  VOTE_DELTA_BUFFER,
  ANOMALY_TRACKER,
  RANDOM_BYTES,
  CURSOR_CODEC,
];

/**
 * Everything discussions keeps in its own stores and its read side that needs neither identity nor catalog: the
 * ScyllaDB and Redis adapters bound to the ports of `domain/ports.ts`, counts, rankings, views and the R1 batch query.
 * Shared by the HTTP side (`DiscussionsModule`) and the background side (`DiscussionsWorkerModule`), so neither owns
 * a second copy of a provider (S25 G7).
 */
@Module({
  imports: [CassandraModule],
  providers: [
    {
      provide: SCYLLA_CLIENT,
      inject: [CassandraService],
      useFactory: (cassandra: CassandraService) => cassandra.client,
    },
    {
      provide: REDIS_CLIENT,
      inject: [RedisService],
      useFactory: (redis: RedisService) => redis.client,
    },
    { provide: RANDOM_BYTES, useValue: cryptoRandomBytes },
    {
      provide: CURSOR_CODEC,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) =>
        hmacCursorCodec(config.get('discussions_cursor_secret')),
    },
    ScyllaStore,
    RedisGuard,
    { provide: POST_STORE, useClass: ScyllaPostStore },
    { provide: COMMENT_STORE, useClass: ScyllaCommentStore },
    { provide: VOTE_STORE, useClass: ScyllaVoteStore },
    { provide: CLAIM_STORE, useClass: ScyllaClaimStore },
    { provide: EVENT_STORE, useClass: ScyllaEventStore },
    { provide: SHADOW_STORE, useClass: ScyllaShadowStore },
    { provide: COUNT_STORE, useClass: ScyllaCountStore },
    { provide: COUNT_CACHE, useClass: RedisCountCache },
    { provide: RANK_CACHE, useClass: RedisRankingCache },
    { provide: PAGE_CACHE, useClass: RedisPageCache },
    { provide: VOTE_DELTA_BUFFER, useClass: RedisVoteDeltaBuffer },
    { provide: ANOMALY_TRACKER, useClass: RedisAnomalyTracker },
    DiscussionIds,
    CountsService,
    RankingService,
    ViewService,
    DiscussionQueryService,
  ],
  exports: [
    ...PORTS,
    SCYLLA_CLIENT,
    REDIS_CLIENT,
    ScyllaStore,
    RedisGuard,
    DiscussionIds,
    CountsService,
    RankingService,
    ViewService,
    DiscussionQueryService,
  ],
})
export class DiscussionsStoresModule {}
