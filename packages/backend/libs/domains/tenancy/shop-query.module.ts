import { Module } from '@nestjs/common';
import { SHOP_REPOSITORY } from './domain/ports';
import { SequelizeShopRepository } from './infra/models/shop.repository';
import { ShopQueryService } from './application/shop-query.service';

/**
 * `ShopQueryService` alone (R1 reads), for modules and workers that only look shops up. It brings no HTTP route and no
 * event wiring, unlike `TenancyModule`.
 */
@Module({
  providers: [
    { provide: SHOP_REPOSITORY, useClass: SequelizeShopRepository },
    ShopQueryService,
  ],
  exports: [ShopQueryService],
})
export class ShopQueryModule {}
