import { Module } from '@nestjs/common';
import { AuthModule, UserUtilsModule } from '@app/domains/identity';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import { PaymentDtoModule } from '@app/domains/payments';
import { PaymentQueryService } from './payment-query.service';
import { PaymentQueryController } from './payment-query.controller';

@Module({
  imports: [AuthModule, DbUtilsModule, UserUtilsModule, PaymentDtoModule],
  providers: [PaymentQueryService],
  controllers: [PaymentQueryController],
})
export class PaymentQueryModule {}
