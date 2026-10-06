import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { LeaderboardService } from './application/leaderboard.service';
import { ShopDashboardService } from './application/shop-dashboard.service';
import { LeaderboardsController } from './api/leaderboards.controller';

/** SD-18 reads (core). */
@Module({
  imports: [AuthModule, ClickHouseModule, CacheModule],
  providers: [LeaderboardService, ShopDashboardService],
  exports: [LeaderboardService],
  controllers: [LeaderboardsController],
})
export class LeaderboardsModule {}
