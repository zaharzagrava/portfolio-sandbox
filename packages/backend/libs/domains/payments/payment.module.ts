import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import { PaymentDtoModule } from './payment-dto.module';
import Payment from './infra/models/payment.model';
import { PaymentService } from './application/payment.service';
import { PaymentController } from './api/payment.controller';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { LedgerModule } from './ledger.module';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { KafkaConsumerModule } from '@app/infrastructure/kafka/kafka-consumer.module';
import { BisUtilsModule } from './bis-utils.module';

@Module({
  imports: [
    SequelizeModule.forFeature([Payment]),
    ApiConfigModule,
    DbUtilsModule,
    BisUtilsModule,
    PaymentDtoModule,
    StripeModule,
    LedgerModule,
    OutboxModule,
    KafkaConsumerModule,
  ],
  providers: [PaymentService],
  exports: [PaymentService],
  controllers: [PaymentController],
})
export class PaymentModule {}
