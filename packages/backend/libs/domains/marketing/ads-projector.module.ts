import { Module } from '@nestjs/common';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { AdsStoresModule } from './ads-stores.module';
import { CampaignLifecycleService } from './application/campaign-lifecycle.service';
import { MARKETING_AGGREGATE } from './application/events/ads-events';
import { SnapshotEffectsService } from './application/snapshot-effects.service';
import { AdsProductSnapshotProjector } from './infra/product-snapshot.projector';
import { AdsShopSnapshotProjector } from './infra/shop-snapshot.projector';

/**
 * Sponsored listings, read-model side (S36, apps/projector): the product and shop snapshot consumers. The app lists
 * `AdsProjectorModule.projectors` in `ProjectionsModule.forProjectors` and imports this module for what they inject. The
 * effects write campaign transitions and their outbox events, hence the events module and the lifecycle service; the R1
 * lookups of creation are not needed here.
 */
@Module({
  imports: [
    AdsStoresModule,
    ClockModule,
    EventsModule.forAggregates([MARKETING_AGGREGATE]),
  ],
  providers: [
    CampaignLifecycleService,
    SnapshotEffectsService,
    AdsProductSnapshotProjector,
    AdsShopSnapshotProjector,
  ],
  // the consumer host resolves the projectors' own dependencies through these
  exports: [
    AdsProductSnapshotProjector,
    AdsShopSnapshotProjector,
    SnapshotEffectsService,
    AdsStoresModule,
    ClockModule,
  ],
})
export class AdsProjectorModule {
  static readonly projectors = [
    AdsProductSnapshotProjector,
    AdsShopSnapshotProjector,
  ];
}
