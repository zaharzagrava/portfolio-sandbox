import { Module } from '@nestjs/common';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { OrderExportRunService } from './application/order-export-run.service';
import { OrderExportConsumer } from './infra/order-export.consumer';
import { OrderExportJobs } from './infra/order-export.jobs';
import {
  OrderExportOffboardingConsumer,
  OrderExportShopDeletedConsumer,
} from './infra/order-export.tenancy.consumers';
import { OrderExportCoreModule } from './order-export-core.module';

/**
 * The run service and what it needs, without a queue consumer, jobs or event consumers: the e2e specs load this module
 * alone and call the handlers directly, so nothing starts in a spec (as `OrdersJobsModule` for orders).
 */
@Module({
  imports: [OrderExportCoreModule],
  providers: [OrderExportRunService],
  exports: [OrderExportRunService],
})
export class OrderExportRunModule {}

/**
 * Background side (apps/worker) of the order export: the consumer of `order-exports` on top of the run service, the
 * three scheduled jobs (recovery, expiry, purge) and the two tenancy event consumers.
 */
@Module({
  imports: [
    OrderExportRunModule,
    OrderExportCoreModule,
    JobsModule,
    ProjectionsModule.forProjectors(
      [OrderExportOffboardingConsumer, OrderExportShopDeletedConsumer],
      [OrderExportCoreModule],
    ),
  ],
  providers: [OrderExportConsumer, OrderExportJobs],
})
export class OrderExportWorkerModule {}
