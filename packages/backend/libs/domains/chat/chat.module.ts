import { Module } from '@nestjs/common';
import { ChatController } from './api/chat.controller';
import { ChatService } from './application/chat.service';
import { ChatDtoModule } from './chat-dto.module';
import { ProductDtoModule } from '@app/domains/catalog';
import { RedisPubSubModule } from '@app/infrastructure/redis-pubsub/redis-pubsub.module';
import { ApiConfigModule } from '@app/common/config';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import { AuthModule } from '@app/domains/identity';

@Module({
  imports: [
    // Firewall guards resolve AuthService from this module's injector
    AuthModule,
    ChatDtoModule,
    ProductDtoModule,
    RedisPubSubModule,
    ApiConfigModule,
    DbUtilsModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
