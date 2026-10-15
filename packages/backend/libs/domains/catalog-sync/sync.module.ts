import { hostname } from 'node:os';
import { Module, type Provider } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { ApiConfigService } from '@app/common/config';
import { CLOCK } from '@app/common/core/clock';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { jsonBodyLimits } from '@app/infrastructure/platform';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { catalogSyncRatePolicies } from './rate-limit-policies';
import { CATALOG_SYNC_AGGREGATE } from './application/events/integration-events';
import { SyncClockService } from './application/sync-clock.service';
import { SyncConflictService } from './application/sync-conflict.service';
import { SyncLifecycleService } from './application/sync-lifecycle.service';
import { SyncPullService } from './application/sync-pull.service';
import { SyncPushService } from './application/sync-push.service';
import { SyncConflictsController } from './api/sync-conflicts.controller';
import { SyncController } from './api/sync.controller';
import { resolveSyncConfig } from './domain/sync-config';
import {
  SYNC_CATALOG_GATEWAY,
  SYNC_CLOCK,
  SYNC_CONFIG,
  SYNC_CONFLICT_REPOSITORY,
  SYNC_FEED_REPOSITORY,
  SYNC_FIELD_CLOCK_REPOSITORY,
  SYNC_INSTANCE,
  SYNC_MONOTONIC,
  SYNC_OPERATION_REPOSITORY,
  SYNC_PRODUCT_EDIT_LOCK,
} from './domain/ports';
import { OfflineSyncJobs } from './infra/offline-sync.jobs';
import { PgAdvisoryProductEditLock } from './infra/pg-advisory-product-edit-lock';
import {
  SequelizeFieldClockRepository,
  SequelizeSyncConflictRepository,
  SequelizeSyncFeedRepository,
  SequelizeSyncOperationRepository,
} from './infra/repositories';
import { SyncCatalogServicesGateway } from './infra/sync-catalog.adapter';
import { SyncFeedConsumer } from './infra/sync-feed.consumer';
import {
  OfflineProductDeletedConsumer,
  OfflineShopDeletedConsumer,
} from './infra/sync-lifecycle.consumers';

// A push may carry 500 operations: its body limit is 2 MiB (the platform default is 1 MiB). Over it: 413.
jsonBodyLimits.register({
  match: /\/shops\/[^/]+\/sync\/push$/,
  limit: '2mb',
});

/** Ports bound to their adapters. `SYNC_CONFIG` is validated when the module is built, so a bad number fails startup. */
const ADAPTERS: Provider[] = [
  {
    provide: SYNC_OPERATION_REPOSITORY,
    useClass: SequelizeSyncOperationRepository,
  },
  { provide: SYNC_FEED_REPOSITORY, useClass: SequelizeSyncFeedRepository },
  {
    provide: SYNC_FIELD_CLOCK_REPOSITORY,
    useClass: SequelizeFieldClockRepository,
  },
  {
    provide: SYNC_CONFLICT_REPOSITORY,
    useClass: SequelizeSyncConflictRepository,
  },
  { provide: SYNC_PRODUCT_EDIT_LOCK, useClass: PgAdvisoryProductEditLock },
  { provide: SYNC_CATALOG_GATEWAY, useClass: SyncCatalogServicesGateway },
  { provide: SYNC_CLOCK, useExisting: CLOCK },
  {
    provide: SYNC_CONFIG,
    inject: [ApiConfigService],
    useFactory: (config: ApiConfigService) =>
      resolveSyncConfig((key) => config.get(key)),
  },
  { provide: SYNC_MONOTONIC, useValue: () => performance.now() },
  { provide: SYNC_INSTANCE, useValue: `${hostname()}-${process.pid}` },
];

/** Every module imports what it injects, so each boots alone (L-018). */
const BASE = [
  AuthModule,
  ClockModule,
  TenancyModule,
  ProductModule,
  RateLimitModule.forFeature(catalogSyncRatePolicies),
  EventsModule.forAggregates([CATALOG_SYNC_AGGREGATE]),
];

const APPLICATION = [
  SyncClockService,
  SyncPushService,
  SyncPullService,
  SyncConflictService,
  SyncLifecycleService,
];

/** apps/core: push, pull, conflict review. Nothing is exported (no model, repository or service). */
@Module({
  imports: BASE,
  providers: [...ADAPTERS, ...APPLICATION],
  controllers: [SyncController, SyncConflictsController],
})
export class OfflineSyncModule {}

/** apps/worker: recovery of unfinished operations, feed compaction, retention and the feed backfill. */
@Module({
  imports: [...BASE, JobsModule],
  providers: [...ADAPTERS, ...APPLICATION, OfflineSyncJobs],
})
export class OfflineSyncWorkerModule {}

/** apps/projector: the feed builder and the two lifecycle consumers. */
@Module({
  imports: BASE,
  providers: [
    ...ADAPTERS,
    ...APPLICATION,
    SyncFeedConsumer,
    OfflineProductDeletedConsumer,
    OfflineShopDeletedConsumer,
  ],
  // The projection framework builds the consumers in its own module, so what they inject must be exported.
  exports: [
    ...ADAPTERS.map((p) => (p as { provide: symbol }).provide),
    ...APPLICATION,
  ],
})
export class OfflineSyncProjectorModule {
  /** Every consumer of this capability, for the projector app's list. */
  static readonly projectors = [
    SyncFeedConsumer,
    OfflineProductDeletedConsumer,
    OfflineShopDeletedConsumer,
  ];
}
