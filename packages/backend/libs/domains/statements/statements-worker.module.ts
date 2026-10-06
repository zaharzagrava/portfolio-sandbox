import { Module } from '@nestjs/common';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { StatementService } from './application/statement.service';
import { StatementsJobs } from './infra/statements.jobs';

/** SD-41 background side (apps/worker): month close, retroactive adjustments. */
@Module({
  imports: [JobsModule],
  providers: [StatementService, StatementsJobs],
})
export class StatementsWorkerModule {}
