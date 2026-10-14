import { Module } from '@nestjs/common';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { InboxModule } from '@app/infrastructure/inbox';
import { ApiKeysService } from './application/api-keys.service';
import { ApiVersionService } from './application/api-version.service';
import { API_AGGREGATE } from './application/events/api-events';
import { KeyPeppers } from './application/key-peppers';
import { KeyUsageFlusher } from './application/key-usage.flusher';
import { KeyVerifier } from './application/key-verifier.service';
import { RequestLogService } from './application/request-log.service';
import { ShopLifecycleHandler } from './application/shop-lifecycle.handler';
import { ShopStatusGate } from './application/shop-status.gate';
import { UsageCloser } from './application/usage.closer';
import { UsageMeteringHandler } from './application/usage-metering.handler';
import { UsageReportService } from './application/usage-report.service';
import {
  ApiKeyRepository,
  BulkJobRepository,
  KeyCache,
  RequestLogStore,
  SettingsRepository,
  ShopDirectory,
  ShopStatusCache,
  UsageBucketRepository,
  VersionPinCache,
} from './domain/ports';
import { ClickHouseRequestLogStore } from './infra/clickhouse-request-log.store';
import { RedisKeyCache } from './infra/redis-key-cache';
import { RedisShopStatusCache } from './infra/redis-shop-status-cache';
import { RedisVersionPinCache } from './infra/redis-version-pin-cache';
import { SequelizeApiKeyRepository } from './infra/sequelize-api-key.repository';
import { SequelizeBulkJobRepository } from './infra/sequelize-bulk-job.repository';
import { SequelizeSettingsRepository } from './infra/sequelize-settings.repository';
import { SequelizeUsageBucketRepository } from './infra/sequelize-usage-bucket.repository';
import { TenancyShopDirectory } from './infra/shop-directory.adapter';

/** Billable usage is emitted on the platform's `usage.events` (S18 consumes it). */
const USAGE_AGGREGATE = {
  aggregateType: 'usage',
  retention: 'full-history' as const,
};

/**
 * What every deployable of the capability shares (dashboard, public API, worker, projector): the ports with their
 * adapters and the application services built on them. Each deployable module imports this one explicitly (L-018) next
 * to what it adds; nothing here is exported by the barrel.
 */
@Module({
  imports: [
    EventsModule.forAggregates([API_AGGREGATE, USAGE_AGGREGATE]),
    ClickHouseModule,
    InboxModule,
  ],
  providers: [
    { provide: ApiKeyRepository, useClass: SequelizeApiKeyRepository },
    { provide: SettingsRepository, useClass: SequelizeSettingsRepository },
    { provide: BulkJobRepository, useClass: SequelizeBulkJobRepository },
    {
      provide: UsageBucketRepository,
      useClass: SequelizeUsageBucketRepository,
    },
    { provide: RequestLogStore, useClass: ClickHouseRequestLogStore },
    { provide: KeyCache, useClass: RedisKeyCache },
    { provide: ShopStatusCache, useClass: RedisShopStatusCache },
    { provide: VersionPinCache, useClass: RedisVersionPinCache },
    { provide: ShopDirectory, useClass: TenancyShopDirectory },
    KeyPeppers,
    ApiKeysService,
    ApiVersionService,
    KeyVerifier,
    KeyUsageFlusher,
    ShopLifecycleHandler,
    ShopStatusGate,
    RequestLogService,
    UsageReportService,
    UsageMeteringHandler,
    UsageCloser,
  ],
  exports: [
    ApiKeyRepository,
    SettingsRepository,
    BulkJobRepository,
    UsageBucketRepository,
    RequestLogStore,
    KeyCache,
    ShopStatusCache,
    VersionPinCache,
    ShopDirectory,
    KeyPeppers,
    ApiKeysService,
    ApiVersionService,
    KeyVerifier,
    KeyUsageFlusher,
    ShopLifecycleHandler,
    ShopStatusGate,
    RequestLogService,
    UsageReportService,
    UsageMeteringHandler,
    UsageCloser,
  ],
})
export class DeveloperPlatformCoreModule {}
