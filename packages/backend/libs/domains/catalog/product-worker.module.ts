import { Module } from '@nestjs/common';
import { TenancyModule } from '@app/domains/tenancy';
import { CacheModule } from '@app/infrastructure/cache';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { ProductBackfillService } from './application/product-backfill.service';
import { ProductCacheInvalidation } from './application/product-cache-invalidation.service';
import { ProductViewsService } from './application/product-views.service';
import { ShopListingService } from './application/shop-listing.service';
import {
  LEGACY_BACKFILL_REPOSITORY,
  SHOP_STATE_REPOSITORY,
  SHOP_SWEEP_REPOSITORY,
  STOCK_OPERATION_REPOSITORY,
  VIEW_BATCH_REPOSITORY,
} from './domain/ports';
import { ProductBackfillJobs } from './infra/product-backfill.jobs';
import { ProductMaintenanceJobs } from './infra/product-maintenance.jobs';
import { ProductViewsJobs } from './infra/product-views.jobs';
import {
  SequelizeLegacyBackfillRepository,
  SequelizeShopStateRepository,
  SequelizeShopSweepRepository,
} from './infra/shop-lifecycle.repository';
import { ShopLifecycleJobs } from './infra/shop-lifecycle.jobs';
import { SequelizeStockOperationRepository } from './infra/stock-operation.repository';
import { SequelizeViewBatchRepository } from './infra/view-batch.repository';

/** Product background jobs, hosted by apps/worker. */
@Module({
  imports: [ClockModule, CacheModule, TenancyModule, OutboxModule],
  providers: [
    ProductViewsService,
    ProductViewsJobs,
    ProductMaintenanceJobs,
    ShopLifecycleJobs,
    ShopListingService,
    ProductCacheInvalidation,
    ProductBackfillService,
    ProductBackfillJobs,
    {
      provide: STOCK_OPERATION_REPOSITORY,
      useClass: SequelizeStockOperationRepository,
    },
    { provide: VIEW_BATCH_REPOSITORY, useClass: SequelizeViewBatchRepository },
    { provide: SHOP_STATE_REPOSITORY, useClass: SequelizeShopStateRepository },
    { provide: SHOP_SWEEP_REPOSITORY, useClass: SequelizeShopSweepRepository },
    {
      provide: LEGACY_BACKFILL_REPOSITORY,
      useClass: SequelizeLegacyBackfillRepository,
    },
  ],
})
export class ProductWorkerModule {}
