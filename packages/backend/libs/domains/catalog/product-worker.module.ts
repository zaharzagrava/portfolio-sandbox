import { Module } from '@nestjs/common';
import { ProductViewsJobs } from './infra/product-views.jobs';

/** Product background jobs, hosted by apps/worker. */
@Module({
  providers: [ProductViewsJobs],
})
export class ProductWorkerModule {}
