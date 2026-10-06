import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { CommissionRateService } from './application/commission-rate.service';
import { StatementService } from './application/statement.service';
import { ReportingPool } from './infra/reporting-pool';
import { StatementsController } from './api/statements.controller';

/** SD-41 (core). */
@Module({
  imports: [AuthModule, JobsModule],
  providers: [CommissionRateService, StatementService, ReportingPool],
  exports: [CommissionRateService, StatementService],
  controllers: [StatementsController],
})
export class StatementsModule {}
