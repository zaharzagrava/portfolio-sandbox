import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { ProductModule } from '@app/domains/catalog';
import { ORDER_EXPORT_AGGREGATE } from './application/events/order-export-finished.event';
import { OrderExportCommandService } from './application/order-export-command.service';
import { OrderExportMaintenanceService } from './application/order-export-maintenance.service';
import { OrderExportQueryService } from './application/order-export-query.service';
import {
  EXPORT_FILES,
  EXPORT_JOBS,
  EXPORT_LINES,
  EXPORT_LIVE,
  EXPORT_QUEUE,
  EXPORT_SKUS,
} from './domain/export-ports';
import { exportConfigProvider } from './infra/export-config.provider';
import { SequelizeExportJobRepository } from './infra/export-job.repository';
import { ExportFileSink } from './infra/export-file.sink';
import { ExportLineReader } from './infra/export-line.reader';
import { ExportLiveAdapter } from './infra/export-live.adapter';
import { ExportQueueAdapter } from './infra/export-queue.adapter';
import { ExportSkuAdapter } from './infra/export-sku.adapter';

/**
 * Everything the HTTP side (`OrderExportModule`) and the background side (`OrderExportWorkerModule`) share: the ports
 * bound to their adapters, the validated settings and the services of start, cancel, download and read. One module, so
 * the two sides never declare the same provider twice.
 */
@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    EventsModule.forAggregates([ORDER_EXPORT_AGGREGATE]),
    RealtimeModule,
    SqsModule,
    StorageModule,
    ProductModule,
  ],
  providers: [
    exportConfigProvider,
    { provide: EXPORT_JOBS, useClass: SequelizeExportJobRepository },
    { provide: EXPORT_LINES, useClass: ExportLineReader },
    { provide: EXPORT_FILES, useClass: ExportFileSink },
    { provide: EXPORT_SKUS, useClass: ExportSkuAdapter },
    { provide: EXPORT_LIVE, useClass: ExportLiveAdapter },
    { provide: EXPORT_QUEUE, useClass: ExportQueueAdapter },
    OrderExportCommandService,
    OrderExportQueryService,
    OrderExportMaintenanceService,
  ],
  exports: [
    exportConfigProvider,
    EXPORT_JOBS,
    EXPORT_LINES,
    EXPORT_FILES,
    EXPORT_SKUS,
    EXPORT_LIVE,
    EXPORT_QUEUE,
    OrderExportCommandService,
    OrderExportQueryService,
    OrderExportMaintenanceService,
  ],
})
export class OrderExportCoreModule {}
