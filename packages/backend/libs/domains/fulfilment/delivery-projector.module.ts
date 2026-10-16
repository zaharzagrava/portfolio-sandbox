import { Module, type Type } from '@nestjs/common';
import type { Projector } from '@app/infrastructure/projections/projector';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { DeliveryCoreModule } from './delivery-core.module';
import { TRACK_STORE } from './domain/delivery-ports';
import { CourierTrackProjector } from './infra/courier-track.projector';
import {
  DeliveryOrderCancelledProjector,
  DeliveryOrderPaidProjector,
  DeliveryShopDeletedProjector,
} from './infra/delivery-order.consumers';
import { DynamoTrackStore } from './infra/track-store';

/**
 * The delivery event consumers, hosted by `apps/projector`: the app lists `DeliveryProjectorModule.projectors` in
 * `ProjectionsModule.forProjectors` and imports this module for what they inject (S20 D-8, A33). The history consumer of
 * the courier track, the `order.paid` consumer that keeps the deliverable-order copy, and the `order.cancelled` (also
 * updates the copy) and `tenancy.shop_deleted` consumers that cancel open deliveries.
 */
@Module({
  imports: [DynamoModule, DeliveryCoreModule],
  providers: [
    { provide: TRACK_STORE, useClass: DynamoTrackStore },
    CourierTrackProjector,
    DeliveryOrderCancelledProjector,
    DeliveryOrderPaidProjector,
    DeliveryShopDeletedProjector,
  ],
  exports: [
    // what the consumers inject, for the host that registers them (`ProjectionsModule.forProjectors`)
    DeliveryCoreModule,
    CourierTrackProjector,
    DeliveryOrderCancelledProjector,
    DeliveryOrderPaidProjector,
    DeliveryShopDeletedProjector,
    TRACK_STORE,
  ],
})
export class DeliveryProjectorModule {
  static readonly projectors: Type<Projector>[] = [
    CourierTrackProjector,
    DeliveryOrderCancelledProjector,
    DeliveryOrderPaidProjector,
    DeliveryShopDeletedProjector,
  ];
}
