import { Module } from '@nestjs/common';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { CHAT_AGGREGATE } from './application/events/chat-events';
import { ChatCoreModule } from './chat-core.module';
import { ChatOfflineScheduler } from './infra/chat-offline.scheduler';
import { ChatShopPurgeConsumer } from './infra/chat-shop-purge.consumer';

/**
 * The projector side (apps/projector): what the consumers of `chat.events` (and `tenancy.events`) inject. The consumers
 * themselves are started by `ProjectionsModule.forProjectors(ChatProjectorModule.projectors, [ChatProjectorModule])`;
 * the e2e specs list the same classes as providers and call `project` directly, so no Kafka consumer starts in a spec.
 */
@Module({
  imports: [
    ChatCoreModule,
    SqsModule,
    EventsModule.forAggregates([CHAT_AGGREGATE]),
  ],
  providers: [ChatOfflineScheduler, ChatShopPurgeConsumer],
  exports: [
    ChatCoreModule,
    SqsModule,
    ChatOfflineScheduler,
    ChatShopPurgeConsumer,
  ],
})
export class ChatProjectorModule {
  /** Every consumer of this domain, for the projector app's list. */
  static readonly projectors = [ChatOfflineScheduler, ChatShopPurgeConsumer];
}
