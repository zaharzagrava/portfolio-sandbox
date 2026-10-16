import { Module } from '@nestjs/common';
import { ProductQueryService } from './application/product-query.service';
import { PRODUCT_REPOSITORY } from './domain/ports';
import { SequelizeProductRepository } from './infra/product.repository';

/**
 * `ProductQueryService` alone (R1 reads), for projectors and workers that only look products up. It brings no HTTP
 * route, no cache and no event wiring, unlike `ProductModule`.
 */
@Module({
  providers: [
    { provide: PRODUCT_REPOSITORY, useClass: SequelizeProductRepository },
    ProductQueryService,
  ],
  exports: [ProductQueryService],
})
export class ProductQueryModule {}
