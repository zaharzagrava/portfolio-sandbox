import { Module, type Type } from '@nestjs/common';
import type { Projector } from '@app/infrastructure/projections/projector';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { PICKUP_AGGREGATE } from './application/events/pickup-events';
import { PickupProjectionService } from './application/pickup-projection.service';
import {
  PICKUP_AVAILABILITY_INDEX,
  PICKUP_POINT_REPOSITORY,
  PICKUP_STOCK_REPOSITORY,
  PRODUCT_COPY_STORE,
  SHOP_COPY_STORE,
} from './domain/pickup-ports';
import { PickupAvailabilityIndexAdapter } from './infra/availability-index';
import {
  PICKUP_INDEX_STRICT,
  PickupIndexBootstrap,
} from './infra/pickup-index-bootstrap';
import { PickupPointProjector } from './infra/pickup-point.projector';
import { PickupPointSqlRepository } from './infra/pickup-point.repository';
import { PickupProductProjector } from './infra/pickup-product.projector';
import { PickupShopProjector } from './infra/pickup-shop.projector';
import { PickupStockProjector } from './infra/pickup-stock.projector';
import { PickupStockSqlRepository } from './infra/pickup-stock.repository';
import { ProductCopySqlStore } from './infra/product-copy.store';
import { ShopCopySqlStore } from './infra/shop-copy.store';

/**
 * The pickup event consumers, hosted by `apps/projector`: the app lists `PickupProjectorModule.projectors` in
 * `ProjectionsModule.forProjectors` and imports this module for what they inject (S19 D-8, A23). The index mapping is
 * ensured at start-up and an unreachable engine fails the start, so readiness reports it (A19).
 */
@Module({
  imports: [
    ClockModule,
    ElasticsearchModule,
    EventsModule.forAggregates([PICKUP_AGGREGATE]),
  ],
  providers: [
    PickupProjectionService,
    { provide: PICKUP_POINT_REPOSITORY, useClass: PickupPointSqlRepository },
    { provide: PICKUP_STOCK_REPOSITORY, useClass: PickupStockSqlRepository },
    { provide: PRODUCT_COPY_STORE, useClass: ProductCopySqlStore },
    { provide: SHOP_COPY_STORE, useClass: ShopCopySqlStore },
    {
      provide: PICKUP_AVAILABILITY_INDEX,
      useClass: PickupAvailabilityIndexAdapter,
    },
    { provide: PICKUP_INDEX_STRICT, useValue: true },
    PickupIndexBootstrap,
    PickupStockProjector,
    PickupPointProjector,
    PickupProductProjector,
    PickupShopProjector,
  ],
  exports: [
    PickupProjectionService,
    PickupStockProjector,
    PickupPointProjector,
    PickupProductProjector,
    PickupShopProjector,
  ],
})
export class PickupProjectorModule {
  static readonly projectors: Type<Projector>[] = [
    PickupStockProjector,
    PickupPointProjector,
    PickupProductProjector,
    PickupShopProjector,
  ];
}
