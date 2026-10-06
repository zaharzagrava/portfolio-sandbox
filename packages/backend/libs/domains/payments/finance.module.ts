import { AuthModule } from '@app/domains/identity';
import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Payout from './infra/models/payout.model';
import { LedgerModule } from './ledger.module';
import { FinanceController } from './api/finance.controller';

/** SD-20 read endpoints (core). */
@Module({
  imports: [AuthModule, LedgerModule, SequelizeModule.forFeature([Payout])],
  controllers: [FinanceController],
})
export class FinanceModule {}
