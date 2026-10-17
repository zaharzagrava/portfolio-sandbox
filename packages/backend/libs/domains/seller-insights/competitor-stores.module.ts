import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { CrawlerConfig } from './application/crawler.config';
import {
  COMPETITOR_SHOP_REPOSITORY,
  FRONTIER,
  OBSERVATION_HISTORY,
  PAGE_ARCHIVE,
  ROBOTS_CACHE,
  SAFE_FETCHER,
  SEEN_SET,
  TARGET_REPOSITORY,
  WATCH_REPOSITORY,
} from './domain/crawler-ports';
import {
  ClickHouseObservationHistory,
  COMPETITOR_CLICKHOUSE,
} from './infra/clickhouse-observation-history';
import CompetitorShop from './infra/models/competitor-shop.model';
import CompetitorWatch from './infra/models/competitor-watch.model';
import CrawlTarget from './infra/models/crawl-target.model';
import { PgCompetitorShopRepository } from './infra/pg-competitor-shop.repository';
import { PgTargetRepository } from './infra/pg-target.repository';
import { PgWatchRepository } from './infra/pg-watch.repository';
import {
  CRAWLER_REDIS,
  CRAWLER_WALL_CLOCK,
  RedisFrontier,
} from './infra/redis-frontier';
import { RedisRobotsCache } from './infra/redis-robots-cache';
import { RedisSeenSet } from './infra/redis-seen-set';
import { SafeRequestFetcher } from './infra/safe-fetcher';
import { S3PageArchive } from './infra/s3-page-archive';

/**
 * The stores of the competitor monitor bound to their ports (D-01, L-018): Postgres repositories, the Redis frontier,
 * robots cache and seen-set, the ClickHouse price history, the page archive and the SSRF-safe fetcher. Imported by the
 * core, worker and projector modules so each app boots on its own. Internal to the domain: the barrel does not export it.
 */
@Module({
  imports: [
    SequelizeModule.forFeature([CrawlTarget, CompetitorWatch, CompetitorShop]),
    ClickHouseModule,
    ClockModule,
    StorageModule,
  ],
  providers: [
    CrawlerConfig,
    {
      provide: CRAWLER_REDIS,
      useFactory: (redis: RedisService) => redis.client,
      inject: [RedisService],
    },
    { provide: CRAWLER_WALL_CLOCK, useValue: () => Date.now() },
    { provide: COMPETITOR_CLICKHOUSE, useExisting: ClickHouseService },
    PgWatchRepository,
    PgTargetRepository,
    PgCompetitorShopRepository,
    RedisFrontier,
    RedisRobotsCache,
    RedisSeenSet,
    ClickHouseObservationHistory,
    S3PageArchive,
    SafeRequestFetcher,
    { provide: WATCH_REPOSITORY, useExisting: PgWatchRepository },
    { provide: TARGET_REPOSITORY, useExisting: PgTargetRepository },
    {
      provide: COMPETITOR_SHOP_REPOSITORY,
      useExisting: PgCompetitorShopRepository,
    },
    { provide: FRONTIER, useExisting: RedisFrontier },
    { provide: ROBOTS_CACHE, useExisting: RedisRobotsCache },
    { provide: SEEN_SET, useExisting: RedisSeenSet },
    { provide: OBSERVATION_HISTORY, useExisting: ClickHouseObservationHistory },
    { provide: PAGE_ARCHIVE, useExisting: S3PageArchive },
    { provide: SAFE_FETCHER, useExisting: SafeRequestFetcher },
  ],
  exports: [
    CrawlerConfig,
    CRAWLER_REDIS,
    CRAWLER_WALL_CLOCK,
    COMPETITOR_CLICKHOUSE,
    WATCH_REPOSITORY,
    TARGET_REPOSITORY,
    COMPETITOR_SHOP_REPOSITORY,
    FRONTIER,
    ROBOTS_CACHE,
    SEEN_SET,
    OBSERVATION_HISTORY,
    PAGE_ARCHIVE,
    SAFE_FETCHER,
  ],
})
export class CompetitorStoresModule {}
