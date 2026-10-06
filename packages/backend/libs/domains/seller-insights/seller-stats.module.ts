import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { SellerStatsController } from './api/seller-stats.controller';
import { SellerStatsService } from './application/seller-stats.service';

@Module({
  imports: [AuthModule, ClickHouseModule],
  providers: [SellerStatsService],
  controllers: [SellerStatsController],
})
export class SellerStatsModule { }
