/**
 * Public entry point of the `launch-events` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/launch-events`.
 *
 * Booking (S22): the three Nest modules the apps mount, and DTO types. Live stream (S23): the five Nest modules the apps
 * host (core, worker, projector, sse-gateway and its topics) and the contract types. No model, repository, service
 * class, key helper, sampler or consumer class.
 */
export { LaunchEventsModule } from './launch-events.module';
export { LaunchEventsWorkerModule } from './launch-events-worker.module';
export { LaunchEventTopicsModule } from './realtime-topics.module';
export type {
  ConfirmResponseDto,
  HoldDto,
  LaunchEventDto,
  QueueStatusDto,
  LiveComment,
  LiveSnapshotDto,
  LiveStreamDto,
  LivePin,
} from '@marketplace-sandbox/contracts';

export { LiveModule } from './live.module';
export { LiveWorkerModule } from './live-worker.module';
export { LiveProjectorModule } from './live-projector.module';
export { LiveGatewayModule } from './live-gateway.module';
export { LiveTopicsModule } from './live-topics.module';
