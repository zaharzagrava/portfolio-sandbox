import { Module } from '@nestjs/common';
import { AuthModule, UserUtilsModule } from '@app/domains/identity';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import { PaymentDtoModule } from '@app/domains/payments';
import { RedisPubSubModule } from '../redis-pubsub/redis-pubsub.module';
import { PaymentStreamController } from './payment-stream.controller';

@Module({
  imports: [
    AuthModule,
    DbUtilsModule,
    UserUtilsModule,
    PaymentDtoModule,
    RedisPubSubModule,
  ],
  controllers: [PaymentStreamController],
})
export class PaymentStreamModule {}
