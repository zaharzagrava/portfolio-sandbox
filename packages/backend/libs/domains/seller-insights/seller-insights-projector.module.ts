import { Module } from '@nestjs/common';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { ErasureService } from './application/erasure.service';
import { BoardProjector } from './infra/projectors/board.projector';
import { LiveProjector } from './infra/projectors/live.projector';
import {
  ProductCategoryProjector,
  ShopErasureProjector,
  ShopNameProjector,
} from './infra/projectors/read-model.projectors';
import { RefundProjector } from './infra/projectors/refund.projector';
import { SalesProjector } from './infra/projectors/sales.projector';
import { SellerInsightsStoresModule } from './seller-insights-stores.module';

/**
 * Read-model side of seller insights (apps/projector, S40): the consumers of `orders.events` (boards, live counters,
 * sales history, refunds), `products.events` and the tenancy shop events. The app lists
 * `SellerInsightsProjectorModule.projectors` in `ProjectionsModule.forProjectors` and imports this module for what they
 * inject. No consumer class is exported from the domain barrel (X.4, D-8).
 */
@Module({
  imports: [ClockModule, SellerInsightsStoresModule],
  providers: [
    ErasureService,
    BoardProjector,
    LiveProjector,
    SalesProjector,
    RefundProjector,
    ShopNameProjector,
    ShopErasureProjector,
    ProductCategoryProjector,
  ],
  exports: [
    BoardProjector,
    LiveProjector,
    SalesProjector,
    RefundProjector,
    ShopNameProjector,
    ShopErasureProjector,
    ProductCategoryProjector,
    ErasureService,
    // `ProjectionsModule` instantiates the consumers, so it needs what they inject
    SellerInsightsStoresModule,
    ClockModule,
  ],
})
export class SellerInsightsProjectorModule {
  static readonly projectors = [
    BoardProjector,
    LiveProjector,
    SalesProjector,
    RefundProjector,
    ShopNameProjector,
    ShopErasureProjector,
    ProductCategoryProjector,
  ];
}
