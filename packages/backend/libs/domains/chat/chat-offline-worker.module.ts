import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ChatSyncService } from './application/chat-sync.service';
import { ChatOfflineWorker } from './infra/chat-offline';

/** SD-14 offline checks (apps/worker): an unread message for an offline recipient becomes the event `chat.message_escalated`. */
@Module({
  imports: [
    RealtimeModule,
    CacheModule,
    SqsModule,
    EventsModule.forAggregates([
      { aggregateType: 'chat', retention: 'full-history' },
    ]),
  ],
  providers: [ChatSyncService, ChatOfflineWorker],
  exports: [ChatOfflineWorker],
})
export class ChatOfflineWorkerModule {}
