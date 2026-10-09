import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Product from './infra/models/product.model';
import { AuthModule } from '@app/domains/identity';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import { ProductDtoModule } from './product-dto.module';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { ProductService } from './application/product.service';
import { ProductController } from './api/product.controller';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { TenancyModule } from '@app/domains/tenancy';

@Module({
  imports: [
    SequelizeModule.forFeature([Product]),
    AuthModule,
    DbUtilsModule,
    ProductDtoModule,
    ElasticsearchModule,
    OutboxModule,
    CacheModule,
    TenancyModule,
  ],
  providers: [ProductService],
  exports: [ProductService],
  controllers: [ProductController],
})
export class ProductModule {}
