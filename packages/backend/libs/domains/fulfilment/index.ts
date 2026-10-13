/**
 * Public entry point of the `fulfilment` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/fulfilment`. The pickup part exports its modules, the exact-check service and the types of its
 * HTTP and event contracts - no model, repository, index adapter or projector class (S19 D-8, A23).
 */
export { DeliveryWorkerModule } from './delivery-worker.module';
export { DeliveryModule } from './delivery.module';
export { PickupModule } from './pickup.module';
export { PickupProjectorModule } from './pickup-projector.module';
export { CourierTrackProjector } from './infra/delivery-workers';
export { DeliveryTopicsModule } from './realtime-topics.module';
export { PickupAvailabilityService } from './application/pickup-availability.service';
export type {
  AvailabilityAnswer,
  AvailabilityLine,
} from './application/pickup-availability.service';
export { PickupSearchService } from './application/pickup-search.service';
export {
  PickupPointNotFoundError,
  InvalidAvailabilityRequestError,
} from './domain/pickup-errors';
export {
  PickupPointChanged,
  PickupStockChanged,
} from './application/events/pickup-events';
export type * from './api/pickup.dto';
