import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { ChatSyncService } from './application/chat-sync.service';
import { ChatSyncController } from './api/chat-sync.controller';

/** SD-14 (core): send-with-idempotency, sync, unread, receipts, presence. */
@Module({
  imports: [AuthModule, RealtimeModule, CacheModule],
  providers: [ChatSyncService],
  exports: [ChatSyncService],
  controllers: [ChatSyncController],
})
export class ChatSyncModule {}
