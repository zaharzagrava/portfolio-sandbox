import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { CommissionRateService } from './application/commission-rate.service';
import { StatementService } from './application/statement.service';
import { ReportingPool } from './infra/reporting-pool';
import { StatementsController } from './api/statements.controller';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { statementsRatePolicies } from './rate-limit-policies';

/** SD-41 (core). */
@Module({
  imports: [
    AuthModule,
    JobsModule,
    RateLimitModule.forFeature(statementsRatePolicies),
  ],
  providers: [CommissionRateService, StatementService, ReportingPool],
  exports: [CommissionRateService, StatementService],
  controllers: [StatementsController],
})
export class StatementsModule {}
