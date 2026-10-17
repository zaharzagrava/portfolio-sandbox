import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  BOARD_REPOSITORY,
  LIVE_COUNTER_REPOSITORY,
  PRODUCT_CATEGORY_DIRECTORY,
  SALES_HISTORY_REPOSITORY,
  SHOP_DIRECTORY,
  SNAPSHOT_REPOSITORY,
} from './domain/ports';
import {
  ClickHouseSalesHistory,
  INSIGHTS_CLICKHOUSE,
} from './infra/clickhouse-sales-history';
import LeaderboardSnapshot from './infra/models/leaderboard-snapshot.model';
import SellerInsightsProduct from './infra/models/seller-insights-product.model';
import SellerInsightsShop from './infra/models/seller-insights-shop.model';
import { PgProductCategories } from './infra/pg-product-categories';
import { PgShopDirectory } from './infra/pg-shop-directory';
import { PgSnapshotRepository } from './infra/pg-snapshot.repository';
import {
  INSIGHTS_REDIS,
  RedisBoardRepository,
} from './infra/redis-board.repository';
import { RedisLiveCounterRepository } from './infra/redis-live-counter.repository';

/**
 * The stores of seller insights bound to their ports (D-6): Redis boards and live counters, PostgreSQL snapshots and
 * the two read models, ClickHouse sales history. Internal to the domain: the barrel does not export it.
 */
@Module({
  imports: [
    SequelizeModule.forFeature([
      LeaderboardSnapshot,
      SellerInsightsShop,
      SellerInsightsProduct,
    ]),
    ClickHouseModule,
    ClockModule,
  ],
  providers: [
    {
      provide: INSIGHTS_REDIS,
      useFactory: (redis: RedisService) => redis.client,
      inject: [RedisService],
    },
    { provide: INSIGHTS_CLICKHOUSE, useExisting: ClickHouseService },
    RedisBoardRepository,
    RedisLiveCounterRepository,
    PgSnapshotRepository,
    PgShopDirectory,
    PgProductCategories,
    ClickHouseSalesHistory,
    { provide: BOARD_REPOSITORY, useExisting: RedisBoardRepository },
    {
      provide: LIVE_COUNTER_REPOSITORY,
      useExisting: RedisLiveCounterRepository,
    },
    { provide: SNAPSHOT_REPOSITORY, useExisting: PgSnapshotRepository },
    { provide: SHOP_DIRECTORY, useExisting: PgShopDirectory },
    { provide: PRODUCT_CATEGORY_DIRECTORY, useExisting: PgProductCategories },
    { provide: SALES_HISTORY_REPOSITORY, useExisting: ClickHouseSalesHistory },
  ],
  exports: [
    INSIGHTS_REDIS,
    INSIGHTS_CLICKHOUSE,
    BOARD_REPOSITORY,
    LIVE_COUNTER_REPOSITORY,
    SNAPSHOT_REPOSITORY,
    SHOP_DIRECTORY,
    PRODUCT_CATEGORY_DIRECTORY,
    SALES_HISTORY_REPOSITORY,
  ],
})
export class SellerInsightsStoresModule {}
