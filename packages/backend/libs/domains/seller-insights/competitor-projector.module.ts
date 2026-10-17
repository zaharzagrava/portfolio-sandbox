import { Module } from '@nestjs/common';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { CompetitorShopService } from './application/competitor-shop.service';
import { CompetitorStoresModule } from './competitor-stores.module';
import {
  CompetitorProductProjector,
  CompetitorShopProjector,
} from './infra/projectors/competitor.projectors';

/**
 * Consumers of the competitor monitor (apps/projector, S41 FR-029 to FR-031): the shop read model and the product
 * cleanup. The app lists `CompetitorProjectorModule.projectors` in `ProjectionsModule.forProjectors` and imports this
 * module for what they inject. No consumer class is exported from the domain barrel (X.4).
 */
@Module({
  imports: [ClockModule, CompetitorStoresModule],
  providers: [
    CompetitorShopService,
    CompetitorShopProjector,
    CompetitorProductProjector,
  ],
  exports: [
    CompetitorShopProjector,
    CompetitorProductProjector,
    // `ProjectionsModule` instantiates the consumers, so it needs what they inject
    CompetitorShopService,
    CompetitorStoresModule,
    ClockModule,
  ],
})
export class CompetitorProjectorModule {
  static readonly projectors = [
    CompetitorShopProjector,
    CompetitorProductProjector,
  ];
}
