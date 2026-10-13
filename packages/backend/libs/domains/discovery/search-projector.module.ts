import { Module, type Type } from '@nestjs/common';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
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
import { SearchClicksProjector } from './infra/search-clicks.projector';
import { SearchQueriesProjector } from './infra/search-queries.projector';
import { SearchIndexModule } from './search-index.module';

/**
 * The search read-model builders, hosted by `apps/projector`: the app lists `SearchProjectorModule.projectors` in
 * `ProjectionsModule.forProjectors` and imports this module for what they inject (S32 US4).
 */
@Module({
  imports: [SearchIndexModule, ClickHouseModule],
  providers: [
    ProductProjectionService,
    ShopStateProjectionService,
    SignalProjectionService,
    ProductIndexProjector,
    ShopStateProjector,
    MediaProjector,
    SponsorshipProjector,
    SearchClicksProjector,
    SearchQueriesProjector,
  ],
  exports: [
    // the clicks and queries projectors are built inside `ProjectionsModule`, which needs this module's ClickHouse
    ClickHouseModule,
    ProductIndexProjector,
    ShopStateProjector,
    MediaProjector,
    SponsorshipProjector,
    SearchClicksProjector,
    SearchQueriesProjector,
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
    SearchClicksProjector,
    SearchQueriesProjector,
  ];
}
