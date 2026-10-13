import { Module } from '@nestjs/common';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { LedgerModule } from './ledger.module';
import { BalanceBackfillService } from './application/balance-backfill.service';
import { HotAccountSweepService } from './application/hot-account-sweep.service';
import { InvariantCheckService } from './application/invariant-check.service';
import { PartitionMaintenanceService } from './application/partition-maintenance.service';
import { ReconciliationRunService } from './application/reconciliation-run.service';
import { SettlementService } from './application/settlement.service';
import {
  JOB_LOCK,
  LEDGER_MAINTENANCE_STORE,
  PROVIDER_STATEMENT,
} from './domain/ledger-ports';
import { SequelizeLedgerMaintenanceStore } from './infra/ledger-maintenance.store';
import { SettlementConsumer } from './infra/settlement.consumer';
import { LedgerJobs } from './infra/ledger.jobs';
import { RedisJobLock } from './infra/redis-job-support';
import { ReconciliationJobs } from './infra/reconciliation.jobs';
import { StripeStatementAdapter } from './infra/stripe-statement.adapter';

/**
 * The ledger's background work without the consumer framework: the settlement consumer, the reconciliation run, the
 * housekeeping services and the job handlers as providers. `LedgerWorkerModule` registers them with the framework and
 * the scheduler; specs load this module and call the consumer and the handlers directly, so nothing polls in a spec
 * (the pattern of `PaymentProcessingModule`). The provider statement is bound to Stripe here; specs bind it to a
 * scriptable double.
 */
@Module({
  imports: [
    LedgerModule,
    JobsModule,
    StripeModule,
    EventsModule.forAggregates([
      { aggregateType: 'ledger', retention: 'full-history' },
    ]),
  ],
  providers: [
    SettlementService,
    HotAccountSweepService,
    PartitionMaintenanceService,
    InvariantCheckService,
    BalanceBackfillService,
    SettlementConsumer,
    LedgerJobs,
    {
      provide: LEDGER_MAINTENANCE_STORE,
      useClass: SequelizeLedgerMaintenanceStore,
    },
    { provide: JOB_LOCK, useClass: RedisJobLock },
    StripeStatementAdapter,
    { provide: PROVIDER_STATEMENT, useExisting: StripeStatementAdapter },
    ReconciliationRunService,
    ReconciliationJobs,
  ],
  exports: [
    SettlementService,
    HotAccountSweepService,
    PartitionMaintenanceService,
    InvariantCheckService,
    BalanceBackfillService,
    SettlementConsumer,
    LedgerJobs,
    PROVIDER_STATEMENT,
    ReconciliationRunService,
    ReconciliationJobs,
  ],
})
export class LedgerProcessingModule {}
