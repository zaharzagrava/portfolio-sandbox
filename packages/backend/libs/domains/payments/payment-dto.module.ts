import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { AuthModule } from '@app/domains/identity';
import { PaymentDtoService } from './infra/payment-dto.service';
import Payment from './infra/models/payment.model';

@Module({
  imports: [
    SequelizeModule.forFeature([Payment]),
    ApiConfigModule,
    AuthModule,
  ],
  providers: [PaymentDtoService],
  exports: [PaymentDtoService],
  controllers: [],
})
export class PaymentDtoModule { }
