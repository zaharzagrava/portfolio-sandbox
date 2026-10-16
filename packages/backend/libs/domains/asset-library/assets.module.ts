import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors';
import { AuthModule } from '@app/domains/identity';
import { ProductQueryModule } from '@app/domains/catalog';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { AssetsJobs, AssetsSchedule } from './infra/assets.jobs';
import './config-rules'; // registers the start-up rule for the user-content origin
import { ASSET_CONFIG } from './application/asset-config.token';
import { AssetLimits } from './application/asset-limits';
import { AssetNotifier } from './application/asset-notifier';
import { ChunkPresence } from './application/chunk-presence';
import { CleanupService } from './application/cleanup.service';
import {
  DeliveryService,
  LicensingHook,
  NoWatermark,
} from './application/delivery.service';
import { DigitalService } from './application/digital.service';
import { EntitlementService } from './application/entitlement.service';
import { LibraryService } from './application/library.service';
import { PurchasesService } from './application/purchases.service';
import { ShareService } from './application/share.service';
import { UploadService } from './application/upload.service';
import { ASSETS_AGGREGATE } from './application/events/asset-events';
import { ASSET_CONFIG_KEYS, resolveAssetConfig } from './domain/asset-config';
import { ASSET_PROBLEMS } from './domain/errors';
import {
  ASSETS,
  CHUNKS,
  ChunkStore,
  DIGITAL,
  ENTITLEMENTS,
  GRANTS,
  JOURNAL,
  SHARES,
  USAGE,
  VERSIONS,
} from './domain/ports';
import { SequelizeAssetRepository } from './infra/asset.repository';
import { SequelizeChunkRepository } from './infra/chunk.repository';
import { ObjectChunkStore } from './infra/chunk-store';
import { SequelizeDigitalRepository } from './infra/digital.repository';
import { SequelizeEntitlementRepository } from './infra/entitlement.repository';
import { SequelizeGrantRepository } from './infra/grant.repository';
import { SequelizeJournalRepository } from './infra/journal.repository';
import { SequelizeShareRepository } from './infra/share.repository';
import { SequelizeUsageRepository } from './infra/usage.repository';
import { SequelizeVersionRepository } from './infra/version.repository';
import { AssetCatalogShopConsumer } from './infra/catalog-shop.consumer';
import { AssetOrdersConsumer } from './infra/orders.consumer';
import { DigitalController } from './api/digital.controller';
import { DownloadsController } from './api/downloads.controller';
import { LibraryController } from './api/library.controller';
import { PurchasesController } from './api/purchases.controller';
import { ShareController, SharedLinkController } from './api/share.controller';
import { assetRatePolicies } from './rate-limit-policies';

/** The adapters of the ports (D-6); every module that hosts a service of this domain lists them. */
const ADAPTERS = [
  { provide: ASSETS, useClass: SequelizeAssetRepository },
  { provide: VERSIONS, useClass: SequelizeVersionRepository },
  { provide: CHUNKS, useClass: SequelizeChunkRepository },
  { provide: USAGE, useClass: SequelizeUsageRepository },
  { provide: JOURNAL, useClass: SequelizeJournalRepository },
  { provide: SHARES, useClass: SequelizeShareRepository },
  { provide: GRANTS, useClass: SequelizeGrantRepository },
  { provide: DIGITAL, useClass: SequelizeDigitalRepository },
  { provide: ENTITLEMENTS, useClass: SequelizeEntitlementRepository },
  { provide: ChunkStore, useClass: ObjectChunkStore },
];

/** Validated at boot, so an invalid setting fails the start. The environment carries the keys in upper case. */
const CONFIG_PROVIDER = {
  provide: ASSET_CONFIG,
  useFactory: () =>
    resolveAssetConfig(
      Object.fromEntries(
        ASSET_CONFIG_KEYS.map((key) => [key, process.env[key.toUpperCase()]]),
      ),
    ),
};

/** S31 (core): the library, share, digital and download routes. */
@Module({
  imports: [
    AuthModule,
    StorageModule,
    ClockModule,
    RealtimeModule,
    IdempotencyModule,
    ProductQueryModule,
    EventsModule.forAggregates([ASSETS_AGGREGATE]),
    RateLimitModule.forFeature(assetRatePolicies),
    ProblemCatalogModule.forFeature(ASSET_PROBLEMS),
  ],
  providers: [
    ...ADAPTERS,
    CONFIG_PROVIDER,
    AssetLimits,
    AssetNotifier,
    ChunkPresence,
    UploadService,
    LibraryService,
    ShareService,
    DeliveryService,
    DigitalService,
    PurchasesService,
    { provide: LicensingHook, useClass: NoWatermark },
  ],
  controllers: [
    LibraryController,
    ShareController,
    SharedLinkController,
    DownloadsController,
    DigitalController,
    PurchasesController,
  ],
})
export class AssetsModule {}

/** S31 (worker): scheduled jobs and cleanup. Boots on its own: storage, clock and its adapters are all it needs (L-018). */
@Module({
  imports: [StorageModule, ClockModule, JobsModule],
  providers: [
    ...ADAPTERS,
    CONFIG_PROVIDER,
    CleanupService,
    AssetsJobs,
    AssetsSchedule,
  ],
  exports: [CleanupService, AssetsJobs],
})
export class AssetsWorkerModule {}

/** S31 (projector): the consumers of `orders.events`, `products.events` and `tenancy.events` (apps/projector registers them from `projectors`). */
@Module({
  imports: [
    StorageModule,
    ClockModule,
    EventsModule.forAggregates([ASSETS_AGGREGATE]),
  ],
  providers: [...ADAPTERS, CONFIG_PROVIDER, CleanupService, EntitlementService],
  // The projection framework builds the consumers in its own module, so what they inject must be exported.
  exports: [CleanupService, EntitlementService],
})
export class AssetsProjectorModule {
  static readonly projectors = [AssetOrdersConsumer, AssetCatalogShopConsumer];
}
