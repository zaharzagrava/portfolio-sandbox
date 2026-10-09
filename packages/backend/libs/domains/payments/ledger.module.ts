import { Module } from '@nestjs/common';
import { FirebaseModule } from '@app/infrastructure/firebase/firebase.module';
import {
  UserModel as User,
  AuthModule,
  UserUtilsModule,
  UsersDtoModule,
} from '@app/domains/identity';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import { PaymentDtoModule } from './payment-dto.module';
import Payment from './infra/models/payment.model';
import { BisOrderModel as BisOrder } from '@app/domains/orders';
import { LedgerService } from './application/ledger.service';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import LedgerEntry from './infra/models/ledger-entry.model';
import { EventsModule } from '@app/infrastructure/events/events.module';

@Module({
  imports: [
    SequelizeModule.forFeature([LedgerEntry]),
    ApiConfigModule,
    DbUtilsModule,
    AuthModule,
    EventsModule,
  ],
  providers: [LedgerService],
  exports: [LedgerService],
  controllers: [],
})
export class LedgerModule {}
