import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { AuthModule } from '@app/domains/identity';
import { TenancyModule } from '@app/domains/tenancy';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { ProductController } from './api/product.controller';
import { PublicProductController } from './api/public-product.controller';
import { ProductViewsService } from './application/product-views.service';
import { PublicProductService } from './application/public-product.service';
import { PRODUCTS_AGGREGATE } from './application/events/product-events';
import { ProductAudit } from './application/product-audit';
import { ProductCacheInvalidation } from './application/product-cache-invalidation.service';
import { ProductCommandService } from './application/product-command.service';
import { ProductService } from './application/product.service';
import { ProductImportService } from './application/product-import.service';
import { ProductQueryService } from './application/product-query.service';
import { ProductStockService } from './application/product-stock.service';
import {
  PRODUCT_REPOSITORY,
  STATUS_HISTORY_REPOSITORY,
  STOCK_OPERATION_REPOSITORY,
} from './domain/ports';
import { SequelizeStockOperationRepository } from './infra/stock-operation.repository';
import Product from './infra/models/product.model';
import ProductShopState from './infra/models/product-shop-state.model';
import ProductStatusHistory from './infra/models/product-status-history.model';
import ProductStockOperation from './infra/models/product-stock-operation.model';
import ProductViewBatch from './infra/models/product-view-batch.model';
import { SequelizeProductRepository } from './infra/product.repository';
import { SequelizeStatusHistoryRepository } from './infra/status-history.repository';
import { ProductDtoModule } from './product-dto.module';
import { catalogRatePolicies } from './rate-limit-policies';

/** Core: member HTTP routes and the exported services. */
@Module({
  imports: [
    SequelizeModule.forFeature([
      Product,
      ProductStatusHistory,
      ProductStockOperation,
      ProductShopState,
      ProductViewBatch,
    ]),
    AuthModule,
    ClockModule,
    ProductDtoModule,
    ElasticsearchModule,
    EventsModule.forAggregates([PRODUCTS_AGGREGATE]),
    CacheModule,
    TenancyModule,
    RateLimitModule.forFeature(catalogRatePolicies),
  ],
  providers: [
    { provide: PRODUCT_REPOSITORY, useClass: SequelizeProductRepository },
    {
      provide: STOCK_OPERATION_REPOSITORY,
      useClass: SequelizeStockOperationRepository,
    },
    ProductViewsService,
    PublicProductService,
    ProductQueryService,
    ProductStockService,
    ProductImportService,
    {
      provide: STATUS_HISTORY_REPOSITORY,
      useClass: SequelizeStatusHistoryRepository,
    },
    ProductAudit,
    ProductCacheInvalidation,
    ProductCommandService,
    ProductService,
  ],
  exports: [
    ProductCommandService,
    ProductQueryService,
    ProductStockService,
    ProductImportService,
    ProductService,
    PublicProductService,
  ],
  controllers: [ProductController, PublicProductController],
})
export class ProductModule {}
