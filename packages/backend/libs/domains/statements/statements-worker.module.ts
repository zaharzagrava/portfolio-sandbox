import { Module } from '@nestjs/common';
import { StatementsJobs } from './infra/statements.jobs';
import { StatementsCoreModule } from './statements-core.module';

/** Background side (apps/worker): month close, adjustment and verification job handlers. */
@Module({
  imports: [StatementsCoreModule],
  providers: [StatementsJobs],
  exports: [StatementsJobs],
})
export class StatementsWorkerModule {}
