import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { ProductBatchReadController } from './api/product-batch-read.controller';
import { catalogRatePolicies } from './rate-limit-policies';
import { ProductModule } from './product.module';

/** `GET /batch/products` for the BFF. Its own module so only core serves it (not every app importing catalog). */
@Module({
  imports: [
    AuthModule,
    ProductModule,
    RateLimitModule.forFeature(catalogRatePolicies),
  ],
  controllers: [ProductBatchReadController],
})
export class ProductBatchReadModule {}
