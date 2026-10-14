import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ChatChannelController } from './api/chat-channel.controller';
import { ChatModerationController } from './api/chat-moderation.controller';
import { ChatCoreModule } from './chat-core.module';

/** Channels, moderation and the gateway ticket (core). */
@Module({
  imports: [
    // Firewall guards resolve AuthService from this module's injector
    AuthModule,
    ChatCoreModule,
  ],
  controllers: [ChatChannelController, ChatModerationController],
})
export class ChatModule {}
