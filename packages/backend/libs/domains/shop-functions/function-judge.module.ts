import { Module } from '@nestjs/common';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { JudgeRecoveryService } from './application/judge-recovery.service';
import { JudgeService } from './application/judge.service';
import './application/shop-functions.job-types';
import { JudgeConsumer } from './infra/judge.consumer';
import { JudgeJobs } from './infra/judge.jobs';
import { ShopFunctionsStoresModule } from './shop-functions-stores.module';

/**
 * The judge worker (apps/worker): the coordinator that claims a version, hands source and frozen cases to the
 * function-runner and persists the verdicts, the recovery job and the backlog gauges. It holds database credentials but
 * NEVER executes seller code (S45 FR-024): that only happens in the credential-less runner.
 */
@Module({
  imports: [ShopFunctionsStoresModule, SqsModule, JobsModule],
  providers: [JudgeService, JudgeRecoveryService, JudgeConsumer, JudgeJobs],
})
export class FunctionJudgeModule {}
