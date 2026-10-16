import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors/problem-catalog.module';
import { AuthModule } from '@app/domains/identity';
import { ShopQueryModule } from '@app/domains/tenancy';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { FeedController } from './api/feed.controller';
import { CelebrityRecentsService } from './application/celebrity-recents.service';
import { TimelineRebuildService } from './application/timeline-rebuild.service';
import { FeedHydrationService } from './application/feed-hydration.service';
import { FeedReadService } from './application/feed-read.service';
import { FeedReconcileService } from './application/feed-reconcile.service';
import { FollowService } from './application/follow.service';
import { FEED_PROBLEMS } from './domain/feed-errors';
import {
  FEED_ACCOUNT_DIRECTORY,
  FEED_POST_LOOKUP,
  FEED_SHOP_DIRECTORY,
} from './domain/ports';
import { DiscussionsStoresModule } from './discussions-stores.module';
import { FeedStoresModule } from './feed-stores.module';
import { FollowQueryModule } from './follow-query.module';
import { FeedAccountDirectoryAdapter } from './infra/feed-account-directory.adapter';
import { PostLookupAdapter } from './infra/post-lookup.adapter';
import { ShopDirectoryAdapter } from './infra/shop-directory.adapter';
import { communityRatePolicies } from './rate-limit-policies';

/**
 * Follow graph and home feed, HTTP side (S26, apps/core). Not global (E4): other domains reach followers through
 * `FollowQueryModule`. Shops and users are reached only through their exported services behind the two
 * anti-corruption adapters (IV.8).
 */
@Module({
  imports: [
    AuthModule,
    ShopQueryModule,
    FeedStoresModule,
    // S25's batch post query (R1): reached through the post lookup adapter only
    DiscussionsStoresModule,
    FollowQueryModule,
    ProblemCatalogModule.forFeature(FEED_PROBLEMS),
    RateLimitModule.forFeature(communityRatePolicies),
  ],
  providers: [
    { provide: FEED_SHOP_DIRECTORY, useClass: ShopDirectoryAdapter },
    { provide: FEED_ACCOUNT_DIRECTORY, useClass: FeedAccountDirectoryAdapter },
    { provide: FEED_POST_LOOKUP, useClass: PostLookupAdapter },
    FollowService,
    FeedHydrationService,
    TimelineRebuildService,
    CelebrityRecentsService,
    FeedReadService,
    FeedReconcileService,
  ],
  controllers: [FeedController],
  exports: [FollowQueryModule, FeedReconcileService],
})
export class FeedModule {}
