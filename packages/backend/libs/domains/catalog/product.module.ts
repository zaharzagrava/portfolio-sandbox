import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Product from './infra/models/product.model';
import { AuthModule } from '@app/domains/identity';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import { ProductDtoModule } from './product-dto.module';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { PRODUCTS_AGGREGATE } from './application/events/product-events';
import { ProductService } from './application/product.service';
import { ProductController } from './api/product.controller';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { TenancyModule } from '@app/domains/tenancy';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { catalogRatePolicies } from './rate-limit-policies';

@Module({
  imports: [
    SequelizeModule.forFeature([Product]),
    AuthModule,
    DbUtilsModule,
    ProductDtoModule,
    ElasticsearchModule,
    EventsModule.forAggregates([PRODUCTS_AGGREGATE]),
    CacheModule,
    TenancyModule,
    RateLimitModule.forFeature(catalogRatePolicies),
  ],
  providers: [ProductService],
  exports: [ProductService],
  controllers: [ProductController],
})
export class ProductModule {}
