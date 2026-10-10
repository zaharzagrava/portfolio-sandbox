import { Module, type Type } from '@nestjs/common';
import type { Projector } from '@app/infrastructure/projections/projector';
import { ProductProjectionService } from './application/projection/product-projection.service';
import { ShopStateProjectionService } from './application/projection/shop-state-projection.service';
import { SignalProjectionService } from './application/projection/signal-projection.service';
import { ProductIndexProjector } from './infra/projectors/product-index.projector';
import { ShopStateProjector } from './infra/projectors/shop-state.projector';
import {
  MediaProjector,
  SponsorshipProjector,
} from './infra/projectors/signal.projectors';
import { SearchIndexModule } from './search-index.module';

/**
 * The search read-model builders, hosted by `apps/projector`: the app lists `SearchProjectorModule.projectors` in
 * `ProjectionsModule.forProjectors` and imports this module for what they inject (S32 US4).
 */
@Module({
  imports: [SearchIndexModule],
  providers: [
    ProductProjectionService,
    ShopStateProjectionService,
    SignalProjectionService,
    ProductIndexProjector,
    ShopStateProjector,
    MediaProjector,
    SponsorshipProjector,
  ],
  exports: [
    ProductIndexProjector,
    ShopStateProjector,
    MediaProjector,
    SponsorshipProjector,
    ProductProjectionService,
    ShopStateProjectionService,
    SignalProjectionService,
  ],
})
export class SearchProjectorModule {
  static readonly projectors: Type<Projector>[] = [
    ProductIndexProjector,
    ShopStateProjector,
    MediaProjector,
    SponsorshipProjector,
  ];
}
