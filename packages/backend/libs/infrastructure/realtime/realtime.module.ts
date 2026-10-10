import { Global, Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { RealtimeConfig } from './config/realtime.config';
import { RealtimeSubscriptions } from './hub/realtime-subscriptions.service';
import { SubscriptionHub } from './hub/subscription-hub';
import { TopicSubscriber } from './hub/topic-subscriber.service';
import { RealtimeMetrics } from './metrics/realtime-metrics';
import { RealtimePublisher } from './publish/realtime-publisher.service';
import { StreamAuthenticatorRegistry } from './stream/stream-authenticator';
import { TopicRegistry } from './topic-registry';

/**
 * Publisher, topic registry, in-process subscriber and server-side subscription commands, available to every app. The
 * stream endpoint itself is `RealtimeStreamModule`, imported only by the gateway. Requires the global RedisModule.
 */
@Global()
@Module({
  imports: [ApiConfigModule],
  providers: [
    { provide: RealtimeConfig, useFactory: () => RealtimeConfig.from() },
    RealtimeMetrics,
    RealtimePublisher,
    TopicRegistry,
    StreamAuthenticatorRegistry,
    SubscriptionHub,
    TopicSubscriber,
    RealtimeSubscriptions,
  ],
  exports: [
    RealtimeConfig,
    RealtimeMetrics,
    RealtimePublisher,
    TopicRegistry,
    StreamAuthenticatorRegistry,
    SubscriptionHub,
    TopicSubscriber,
    RealtimeSubscriptions,
  ],
})
export class RealtimeModule {}
