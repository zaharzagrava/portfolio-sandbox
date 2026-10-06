/**
 * Public entry point of the `fulfilment` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/fulfilment`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { DeliveryWorkerModule } from './delivery-worker.module';
export { DeliveryModule } from './delivery.module';
export { PickupModule } from './pickup.module';
export { AvailabilityIndex } from './infra/availability-index';
export { CourierTrackProjector } from './infra/delivery-workers';
export { PickupAvailabilityProjector } from './infra/pickup-availability.projector';
export { DeliveryTopicsModule } from './realtime-topics.module';
