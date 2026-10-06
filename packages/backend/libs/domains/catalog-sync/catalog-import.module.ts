import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { CatalogImportService } from './application/catalog-import.service';
import { OrderExportService } from '@app/domains/orders';
import { CatalogImportController } from './api/catalog-import.controller';
import { CatalogImportWorker } from './infra/catalog-import.worker';

const SERVICES = [CatalogImportService, OrderExportService];

/** SD-27 API (core). */
@Module({ imports: [AuthModule, StorageModule, SqsModule, RealtimeModule, RateLimitModule], providers: SERVICES, exports: SERVICES, controllers: [CatalogImportController] })
export class CatalogImportModule {}

/** SD-27 processing (apps/worker). */
@Module({ imports: [StorageModule, SqsModule, RealtimeModule, RateLimitModule], providers: [...SERVICES, CatalogImportWorker] })
export class CatalogImportWorkerModule {}
