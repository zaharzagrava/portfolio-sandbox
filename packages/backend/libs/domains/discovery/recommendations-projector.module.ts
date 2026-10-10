import { Module, type Type } from '@nestjs/common';
import type { Projector } from '@app/infrastructure/projections/projector';
import { ApiConfigModule } from '@app/common/config';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { BasketCaptureService } from './application/basket-capture.service';
import { BASKET_STORE } from './domain/recommendation-ports';
import { ClickhouseBasketStoreAdapter } from './infra/clickhouse-basket-store.adapter';
import { OrderBasketsProjector } from './infra/projectors/order-baskets.projector';
import { RecommendationsSettings } from './infra/recommendations-config';

/**
 * The recommendations read-model builders, hosted by `apps/projector`: the app lists `RecommendationsProjectorModule.projectors`
 * in `ProjectionsModule.forProjectors` and imports this module for what they inject (S34 FR-027).
 */
@Module({
  imports: [ApiConfigModule, ClickHouseModule],
  providers: [
    RecommendationsSettings,
    BasketCaptureService,
    OrderBasketsProjector,
    { provide: BASKET_STORE, useClass: ClickhouseBasketStoreAdapter },
  ],
  exports: [OrderBasketsProjector, BasketCaptureService],
})
export class RecommendationsProjectorModule {
  static readonly projectors: Type<Projector>[] = [OrderBasketsProjector];
}
