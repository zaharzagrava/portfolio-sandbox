import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ChatMessageController } from './api/chat-message.controller';
import { ChatPresenceController } from './api/chat-presence.controller';
import { ChatReadStateController } from './api/chat-read-state.controller';
import { ChatSyncController } from './api/chat-sync.controller';
import { ChatCoreModule } from './chat-core.module';

/** Messages, sync, history, unread, receipts and presence (core). */
@Module({
  imports: [
    // Firewall guards resolve AuthService from this module's injector
    AuthModule,
    ChatCoreModule,
  ],
  controllers: [
    ChatMessageController,
    ChatSyncController,
    ChatReadStateController,
    ChatPresenceController,
  ],
})
export class ChatSyncModule {}
