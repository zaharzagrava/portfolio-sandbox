import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { PickupPointsController } from './api/pickup-points.controller';
import { PickupPublicController } from './api/pickup-public.controller';
import { PickupAvailabilityService } from './application/pickup-availability.service';
import { PickupSearchService } from './application/pickup-search.service';
import {
  DEFAULT_BROWSE_TIMEOUT_MS,
  PICKUP_BROWSE_TIMEOUT_MS,
  PickupBrowseSqlReader,
} from './infra/pickup-browse.reader';
import { PICKUP_AGGREGATE } from './application/events/pickup-events';
import { PickupPointsService } from './application/pickup-points.service';
import { PickupStockService } from './application/pickup-stock.service';
import {
  CATALOG_PRODUCT_READER,
  PICKUP_AVAILABILITY_INDEX,
  PICKUP_BROWSE_READER,
  PICKUP_POINT_REPOSITORY,
  PICKUP_STOCK_REPOSITORY,
  PRODUCT_COPY_STORE,
} from './domain/pickup-ports';
import { PickupPointSqlRepository } from './infra/pickup-point.repository';
import { PickupStockSqlRepository } from './infra/pickup-stock.repository';
import { CatalogProductReaderAdapter } from './infra/catalog-product.reader';
import { ProductCopySqlStore } from './infra/product-copy.store';
import { PickupAvailabilityIndexAdapter } from './infra/availability-index';
import {
  PICKUP_INDEX_STRICT,
  PickupIndexBootstrap,
} from './infra/pickup-index-bootstrap';
import { fulfilmentRatePolicies } from './rate-limit-policies';

/**
 * SD-13 (core): the seller API for pickup points and local stock, the shopper reads and `PickupAvailabilityService`.
 * Product facts come through the catalog's entry point (R1), never its tables; the consumers that keep the index fresh
 * live in `PickupProjectorModule` (S19 D-8, A23).
 */
@Module({
  imports: [
    AuthModule,
    ClockModule,
    ElasticsearchModule,
    ProductModule,
    TenancyModule,
    IdempotencyModule,
    EventsModule.forAggregates([PICKUP_AGGREGATE]),
    RateLimitModule.forFeature(fulfilmentRatePolicies),
  ],
  controllers: [PickupPointsController, PickupPublicController],
  providers: [
    PickupPointsService,
    PickupStockService,
    PickupSearchService,
    PickupAvailabilityService,
    { provide: PICKUP_BROWSE_READER, useClass: PickupBrowseSqlReader },
    { provide: PICKUP_BROWSE_TIMEOUT_MS, useValue: DEFAULT_BROWSE_TIMEOUT_MS },
    { provide: PICKUP_POINT_REPOSITORY, useClass: PickupPointSqlRepository },
    { provide: PICKUP_STOCK_REPOSITORY, useClass: PickupStockSqlRepository },
    { provide: PRODUCT_COPY_STORE, useClass: ProductCopySqlStore },
    { provide: CATALOG_PRODUCT_READER, useClass: CatalogProductReaderAdapter },
    {
      provide: PICKUP_AVAILABILITY_INDEX,
      useClass: PickupAvailabilityIndexAdapter,
    },
    { provide: PICKUP_INDEX_STRICT, useValue: false },
    PickupIndexBootstrap,
  ],
  exports: [PickupAvailabilityService, PickupSearchService],
})
export class PickupModule {}
