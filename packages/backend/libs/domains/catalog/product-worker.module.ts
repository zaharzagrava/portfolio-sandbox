import { Module } from '@nestjs/common';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import {
  STOCK_OPERATION_REPOSITORY,
  VIEW_BATCH_REPOSITORY,
} from './domain/ports';
import { ProductMaintenanceJobs } from './infra/product-maintenance.jobs';
import { ProductViewsJobs } from './infra/product-views.jobs';
import { SequelizeStockOperationRepository } from './infra/stock-operation.repository';
import { SequelizeViewBatchRepository } from './infra/view-batch.repository';

/** Product background jobs, hosted by apps/worker. */
@Module({
  imports: [ClockModule],
  providers: [
    ProductViewsJobs,
    ProductMaintenanceJobs,
    {
      provide: STOCK_OPERATION_REPOSITORY,
      useClass: SequelizeStockOperationRepository,
    },
    { provide: VIEW_BATCH_REPOSITORY, useClass: SequelizeViewBatchRepository },
  ],
})
export class ProductWorkerModule {}
