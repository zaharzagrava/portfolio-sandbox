/**
 * Public entry point of the `launch-events` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/launch-events`.
 *
 * Booking (S22): the three Nest modules the apps mount, and DTO types. No model, repository, service class or ticker.
 * The live stream (S23) keeps its own exports below; trimming them is that capability's to-do.
 */
export { LaunchEventsModule } from './launch-events.module';
export { LaunchEventsWorkerModule } from './launch-events-worker.module';
export { LaunchEventTopicsModule } from './realtime-topics.module';
export type {
  ConfirmResponseDto,
  HoldDto,
  LaunchEventDto,
  QueueStatusDto,
} from '@marketplace-sandbox/contracts';

// S23 (live stream)
export { Reservoir } from './domain/reservoir';
export { LiveCoreModule } from './live-core.module';
export { LiveWorkerModule } from './live-worker.module';
export { LiveModule } from './live.module';
export { LiveService } from './application/live.service';
export { LiveCommentsProjector } from './infra/live-comments.projector';
export {
  ACTIVE_STREAMS,
  firehoseTopic,
  pinKey,
  RECENT_COMMENTS,
  recentKey,
  viewersKey,
} from './infra/live-keys';
export type { LiveComment } from './infra/live-keys';
export { LiveModerationConsumer } from './infra/live-moderation.consumer';
export { LiveTicker } from './infra/live-ticker.service';
export { launchEventsRatePolicies } from './rate-limit-policies';
