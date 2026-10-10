import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { NotificationsCoreModule } from '@app/domains/notifications';
import { ChatSyncService } from './application/chat-sync.service';
import { ChatOfflineWorker } from './infra/chat-offline';

/** SD-14 offline push checks (apps/worker). */
@Module({
  imports: [RealtimeModule, CacheModule, SqsModule, NotificationsCoreModule],
  providers: [ChatSyncService, ChatOfflineWorker],
  exports: [ChatOfflineWorker],
})
export class ChatOfflineWorkerModule {}
