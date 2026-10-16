import { Module } from '@nestjs/common';
import { FollowQueryService } from './application/follow-query.service';
import { FeedStoresModule } from './feed-stores.module';

/**
 * `FollowQueryService` alone (R1 reads of followers for S28 and others): no HTTP route, no consumer, no job. Another
 * domain imports this module, never the stores behind it.
 */
@Module({
  imports: [FeedStoresModule],
  providers: [FollowQueryService],
  exports: [FollowQueryService],
})
export class FollowQueryModule {}
