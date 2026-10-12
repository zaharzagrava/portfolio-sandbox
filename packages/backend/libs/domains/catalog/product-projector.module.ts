import { Module, type Type } from '@nestjs/common';
import { CacheModule } from '@app/infrastructure/cache';
import type { Projector } from '@app/infrastructure/projections/projector';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { ProductCacheInvalidation } from './application/product-cache-invalidation.service';
import { ShopListingService } from './application/shop-listing.service';
import { SHOP_STATE_REPOSITORY, SHOP_SWEEP_REPOSITORY } from './domain/ports';
import { ProductCacheInvalidator } from './infra/product-cache-invalidator.projector';
import {
  ShopDeletedConsumer,
  ShopStatusConsumer,
} from './infra/shop-consumers';
import {
  SequelizeShopStateRepository,
  SequelizeShopSweepRepository,
} from './infra/shop-lifecycle.repository';

/**
 * The catalog's event consumers, hosted by `apps/projector`: the app lists `ProductProjectorModule.projectors` in
 * `ProjectionsModule.forProjectors` and imports this module for what they inject. Nothing here is a projector class
 * for other domains to use.
 */
@Module({
  imports: [CacheModule, ClockModule, JobsModule, OutboxModule],
  providers: [
    ProductCacheInvalidator,
    ShopStatusConsumer,
    ShopDeletedConsumer,
    ShopListingService,
    ProductCacheInvalidation,
    { provide: SHOP_STATE_REPOSITORY, useClass: SequelizeShopStateRepository },
    { provide: SHOP_SWEEP_REPOSITORY, useClass: SequelizeShopSweepRepository },
  ],
  exports: [
    ProductCacheInvalidator,
    ShopStatusConsumer,
    ShopDeletedConsumer,
    ShopListingService,
  ],
})
export class ProductProjectorModule {
  static readonly projectors: Type<Projector>[] = [
    ProductCacheInvalidator,
    ShopStatusConsumer,
    ShopDeletedConsumer,
  ];
}
