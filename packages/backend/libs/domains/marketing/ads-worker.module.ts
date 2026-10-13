import { Module } from '@nestjs/common';
import { LedgerModule } from '@app/domains/payments';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { TransactionalPipeline } from '@app/infrastructure/projections/transactional-pipeline';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { AdsStoresModule } from './ads-stores.module';
import { HourlyBillingService } from './application/hourly-billing.service';
import { ReconciliationService } from './application/reconciliation.service';
import { LEDGER_PORT } from './domain/ads-ports';
import { AdsJobs } from './infra/ads.jobs';
import { AggregateWriter } from './infra/aggregate.writer';
import {
  AGGREGATOR_AUTOSTART,
  ClickAggregator,
} from './infra/click-aggregator.service';
import { ClickLogWriter } from './infra/click-log.writer';
import { LedgerAdapter } from './infra/ledger.adapter';

/**
 * Sponsored listings, background side (S36, apps/worker): the click aggregator on the transactional pipeline, the two
 * ClickHouse writers (raw log, minute aggregates) and the scheduled money jobs. The ledger is reached through its R1
 * service behind `LEDGER_PORT` (`LedgerModule` is the module that provides it). Specs bind `AGGREGATOR_AUTOSTART` to
 * `false` and start instances with their own group ids.
 */
@Module({
  imports: [
    AdsStoresModule,
    ClickHouseModule,
    ClockModule,
    JobsModule,
    LedgerModule,
  ],
  providers: [
    TransactionalPipeline,
    ClickHouseSink,
    ClickAggregator,
    ClickLogWriter,
    AggregateWriter,
    HourlyBillingService,
    ReconciliationService,
    AdsJobs,
    LedgerAdapter,
    { provide: LEDGER_PORT, useExisting: LedgerAdapter },
    { provide: AGGREGATOR_AUTOSTART, useValue: true },
  ],
  exports: [ClickAggregator, ClickLogWriter, AggregateWriter],
})
export class AdsWorkerModule {}
