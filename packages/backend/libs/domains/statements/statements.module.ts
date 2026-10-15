import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { AccountingPeriodsController } from './api/accounting-periods.controller';
import { CommissionRatesController } from './api/commission-rates.controller';
import { StatementsController } from './api/statements.controller';
import { statementsRatePolicies } from './rate-limit-policies';
import { StatementsCoreModule } from './statements-core.module';

/** HTTP side (apps/core): the seller statement reads and the finance operator routes (S16 contracts/http.md). */
@Module({
  imports: [
    StatementsCoreModule,
    AuthModule,
    IdempotencyModule,
    RateLimitModule.forFeature(statementsRatePolicies),
  ],
  controllers: [
    StatementsController,
    CommissionRatesController,
    AccountingPeriodsController,
  ],
  exports: [StatementsCoreModule],
})
export class StatementsModule {}
