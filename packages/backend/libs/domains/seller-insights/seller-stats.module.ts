import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ShopQueryModule } from '@app/domains/tenancy';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { DashboardController } from './api/dashboard.controller';
import { SellerStatsController } from './api/seller-stats.controller';
import { DashboardTodayService } from './application/dashboard-today.service';
import { SellerStatsService } from './application/seller-stats.service';
import { SellerInsightsStoresModule } from './seller-insights-stores.module';

/** S40 analytics reads (apps/core): "today" chart and shop stats, both from the exact sales history. */
@Module({
  imports: [
    AuthModule,
    ShopQueryModule,
    ClockModule,
    SellerInsightsStoresModule,
  ],
  providers: [DashboardTodayService, SellerStatsService],
  controllers: [DashboardController, SellerStatsController],
})
export class SellerStatsModule {}
