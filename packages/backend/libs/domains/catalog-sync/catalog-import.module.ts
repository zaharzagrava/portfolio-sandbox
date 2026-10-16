import { Module, type Provider } from '@nestjs/common';
import { ApiConfigModule, ApiConfigService } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { ProductModule } from '@app/domains/catalog';
import { AuthModule } from '@app/domains/identity';
import { TenancyModule } from '@app/domains/tenancy';
import { AntivirusModule } from '@app/infrastructure/antivirus';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import {
  CatalogImportController,
  ImportCompleteResponseInterceptor,
} from './api/catalog-import.controller';
import { CATALOG_SYNC_AGGREGATE } from './application/events/integration-events';
import { ImportLifecycleService } from './application/import-lifecycle.service';
import { ImportQueryService } from './application/import-query.service';
import { ImportRunnerService } from './application/import-runner.service';
import { ImportStartService } from './application/import-start.service';
import { IMPORT_CONFIG, resolveImportConfig } from './domain/import-limits';
import { IMPORT_PROBLEMS } from './domain/import-problems';
import {
  IMPORT_CATALOG,
  IMPORT_PIPELINE,
  IMPORT_PUBLISHER,
  IMPORT_QUEUE,
  IMPORT_REPOSITORY,
  IMPORT_SCANNER,
  IMPORT_SHOP_ACCESS,
  IMPORT_SHOP_STATUS,
  IMPORT_STORAGE,
} from './domain/ports';
import { ImportCatalogAdapter } from './infra/import-catalog.adapter';
import {
  ImportOffboardingConsumer,
  ImportShopDeletedConsumer,
} from './infra/import-lifecycle.consumers';
import { ImportLiveAdapter } from './infra/import-live.adapter';
import { ImportPipelineAdapter } from './infra/import-pipeline.adapter';
import { ImportQueueAdapter } from './infra/import-queue.adapter';
import { ImportScannerAdapter } from './infra/import-scanner.adapter';
import { ImportStorageAdapter } from './infra/import-storage.adapter';
import {
  TenancyImportShopAccess,
  TenancyImportShopStatus,
} from './infra/import-tenancy.adapters';
import { ImportConsumer } from './infra/import.consumer';
import { ImportJobs } from './infra/import.jobs';
import { catalogSyncRatePolicies } from './rate-limit-policies';
import { SequelizeImportRepository } from './infra/repositories/sequelize-import.repository';

const importConfigProvider: Provider = {
  provide: IMPORT_CONFIG,
  inject: [ApiConfigService],
  useFactory: (config: ApiConfigService) =>
    resolveImportConfig((key) => {
      switch (key) {
        case 'IMPORT_ERROR_CAP':
          return config.get('import_error_cap');
        case 'IMPORT_BUSY_DELAY_SECONDS':
          return config.get('import_busy_delay_seconds');
        case 'IMPORT_SCAN_INACTIVITY_MS':
          return config.get('import_scan_inactivity_ms');
        case 'IMPORT_SCAN_TOTAL_MS':
          return config.get('import_scan_total_ms');
      }
    }),
};

const PORTS: Provider[] = [
  importConfigProvider,
  { provide: IMPORT_REPOSITORY, useClass: SequelizeImportRepository },
  { provide: IMPORT_STORAGE, useClass: ImportStorageAdapter },
  { provide: IMPORT_QUEUE, useClass: ImportQueueAdapter },
  { provide: IMPORT_PUBLISHER, useClass: ImportLiveAdapter },
  { provide: IMPORT_SHOP_STATUS, useClass: TenancyImportShopStatus },
  { provide: IMPORT_SHOP_ACCESS, useClass: TenancyImportShopAccess },
  { provide: IMPORT_CATALOG, useClass: ImportCatalogAdapter },
  { provide: IMPORT_SCANNER, useClass: ImportScannerAdapter },
  { provide: IMPORT_PIPELINE, useClass: ImportPipelineAdapter },
];
const PORT_TOKENS = PORTS.map((p) => (p as { provide: symbol }).provide);

const SERVICES = [
  ImportStartService,
  ImportQueryService,
  ImportLifecycleService,
];

/**
 * Everything the HTTP side (`CatalogImportModule`), the run side and the background side share: the ports bound to
 * their adapters, the validated settings and the services of start, cancel, read and lifecycle. One module, so the
 * sides never declare the same provider twice. Not exported from the domain's `index.ts`.
 */
@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    EventsModule.forAggregates([CATALOG_SYNC_AGGREGATE]),
    RealtimeModule,
    SqsModule,
    StorageModule,
    AntivirusModule,
    ProductModule,
    TenancyModule,
    RateLimitModule.forFeature(catalogSyncRatePolicies),
  ],
  providers: [...PORTS, ...SERVICES],
  exports: [...PORT_TOKENS, ...SERVICES],
})
export class CatalogImportCoreModule {}

/** HTTP side (apps/core) of the bulk import: the `/shops/:shopId/imports` routes. */
@Module({
  imports: [
    CatalogImportCoreModule,
    AuthModule,
    TenancyModule,
    IdempotencyModule,
    ProblemCatalogModule.forFeature(IMPORT_PROBLEMS),
  ],
  providers: [ImportCompleteResponseInterceptor],
  controllers: [CatalogImportController],
})
export class CatalogImportModule {}

/**
 * The runner and what it needs, without a queue consumer or jobs: the e2e specs load this module alone and call the
 * runner directly, so nothing starts in a spec.
 */
@Module({
  imports: [CatalogImportCoreModule],
  providers: [ImportRunnerService],
  exports: [ImportRunnerService],
})
export class CatalogImportRunModule {}

/** Background side (apps/worker): the consumer of `catalog-imports` on top of the runner, and the three scheduled jobs. */
@Module({
  imports: [CatalogImportRunModule, CatalogImportCoreModule, JobsModule],
  providers: [ImportConsumer, ImportJobs],
})
export class CatalogImportWorkerModule {}

/** The two tenancy event consumers (apps/projector registers them from `projectors`). */
@Module({
  imports: [CatalogImportCoreModule],
  exports: [CatalogImportCoreModule],
})
export class CatalogImportProjectorModule {
  /** Every consumer of this capability, for the projector app's list. */
  static readonly projectors = [
    ImportOffboardingConsumer,
    ImportShopDeletedConsumer,
  ];
}
