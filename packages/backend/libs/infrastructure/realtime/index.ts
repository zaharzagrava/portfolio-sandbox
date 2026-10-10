/**
 * Public entry point of the realtime hub (constitution X.4). Callers import from `@app/infrastructure/realtime` only.
 * See specs/domains/S51-realtime-push/contracts/library-api.md.
 */
export { RealtimeModule } from './realtime.module';
export { RealtimeStreamModule } from './realtime-stream.module';
export { realtimeRatePolicies } from './realtime-rate-policies';
export { RealtimePublisher } from './publish/realtime-publisher.service';
export type { PublishResult } from './publish/realtime-publisher.service';
export {
  DuplicateTopicRouteError,
  InvalidTopicDefinitionError,
  TopicRegistry,
  TopicRegistryFrozenError,
} from './topic-registry';
export type {
  TopicDefinition,
  TopicPolicy,
  TopicViewer,
} from './topic-registry';
export { TopicSubscriber } from './hub/topic-subscriber.service';
export { RealtimeSubscriptions } from './hub/realtime-subscriptions.service';
export { SubscriptionHub } from './hub/subscription-hub';
export type { RevocationNotice } from './hub/subscription-hub';
export {
  StreamAuthenticatorRegistry,
  StreamInvalidCredentialError,
} from './stream/stream-authenticator';
export type {
  StreamAuthenticator,
  StreamPrincipal,
} from './stream/stream-authenticator';
export {
  InvalidRealtimeEventTypeError,
  InvalidRealtimePayloadError,
  InvalidRealtimeTopicError,
  RealtimePayloadTooLargeError,
  RealtimeUnavailableError,
} from './errors';
export { RealtimeConfig } from './config/realtime.config';
export type { RealtimeConfigValues } from './config/realtime.config';
export { RealtimeMetrics } from './metrics/realtime-metrics';
export { channelName } from './keys';
export type {
  RealtimeMessage,
  RealtimeTopic,
  RealtimeTopicPrefixes,
} from './topics';
