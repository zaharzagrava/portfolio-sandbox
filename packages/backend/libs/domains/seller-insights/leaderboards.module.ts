import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors/problem-catalog.module';
import { AuthModule } from '@app/domains/identity';
import { ShopQueryModule } from '@app/domains/tenancy';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { LeaderboardsController } from './api/leaderboards.controller';
import { sellerInsightsRatePolicies } from './api/rate-limit-policies';
import { ShopRankController } from './api/shop-rank.controller';
import { LeaderboardReadService } from './application/leaderboard-read.service';
import { ShopRankService } from './application/shop-rank.service';
import { INSIGHTS_PROBLEMS } from './domain/insights-errors';
import { SellerInsightsStoresModule } from './seller-insights-stores.module';

/** S40 board reads (apps/core): the public top list and a shop's own rank. */
@Module({
  imports: [
    AuthModule,
    ShopQueryModule,
    ClockModule,
    SellerInsightsStoresModule,
    RateLimitModule.forFeature(sellerInsightsRatePolicies),
    ProblemCatalogModule.forFeature(INSIGHTS_PROBLEMS),
  ],
  providers: [LeaderboardReadService, ShopRankService],
  controllers: [LeaderboardsController, ShopRankController],
})
export class LeaderboardsModule {}
