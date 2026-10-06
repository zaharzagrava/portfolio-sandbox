import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import ChatChannel from './infra/models/chat-channel.model';
import ChatChannelMember from './infra/models/chat-channel-member.model';
import ChatMessage from './infra/models/chat-message.model';
import { ChatDtoService } from './infra/chat-dto.service';

@Module({
  imports: [
    SequelizeModule.forFeature([ChatChannel, ChatChannelMember, ChatMessage]),
  ],
  providers: [ChatDtoService],
  exports: [ChatDtoService],
})
export class ChatDtoModule {}
