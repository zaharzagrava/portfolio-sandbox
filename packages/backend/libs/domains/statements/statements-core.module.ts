import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { TenancyModule } from '@app/domains/tenancy';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { InboxModule } from '@app/infrastructure/inbox/inbox.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { ConsumerLag } from '@app/infrastructure/projections/consumer-lag';
import { AccountingPeriodService } from './application/accounting-period.service';
import { CommissionRateQueryService } from './application/commission-rate-query.service';
import { CommissionRateService } from './application/commission-rate.service';
import { STATEMENTS_AGGREGATE } from './application/events/statements-events';
import { AdjustmentService, RECONCILE_FAULT } from './application/adjustment.service';
import { FactIngestionService } from './application/fact-ingestion.service';
import { CLOSE_FAULT, PeriodCloseService } from './application/period-close.service';
import { StatementExportService } from './application/statement-export.service';
import { StatementService } from './application/statement.service';
import { VerificationService } from './application/verification.service';
import { WatermarkService } from './application/watermark.service';
import { statementsConfigProvider } from './domain/config';
import { STATEMENTS_PROBLEMS } from './domain/errors';
import {
  ADJUSTMENT_REPOSITORY,
  EXPORT_SOURCE,
  FACT_REPOSITORY,
  FINDING_REPOSITORY,
  PERIOD_REPOSITORY,
  RATE_REPOSITORY,
  SHOP_DIRECTORY,
  SNAPSHOT_REPOSITORY,
  STATEMENT_READER,
  STOP_SIGNAL,
  STREAM_LAG,
} from './domain/ports';
import { SequelizeAdjustmentRepository } from './infra/adjustment.repository';
import { SequelizeCommissionRateRepository } from './infra/commission-rate.repository';
import { SequelizeExportSource } from './infra/export.source';
import { SequelizeFactRepository } from './infra/fact.repository';
import { SequelizeFindingRepository } from './infra/finding.repository';
import { SequelizePeriodRepository } from './infra/period.repository';
import { ReplicaReads, StatementsReplicaModule } from './infra/replica-reads';
import { TenancyShopDirectoryAdapter } from './infra/shop-directory.adapter';
import { SequelizeSnapshotRepository } from './infra/snapshot.repository';
import { SequelizeStatementReader } from './infra/statement.reader';
import { StatementsLifecycle } from './infra/statements-lifecycle';
import { KafkaStreamLag } from './infra/stream-lag.adapter';

/**
 * What the HTTP side (`StatementsModule`), the background side (`StatementsWorkerModule`) and the consumers
 * (`StatementsProjectorModule`) share: repositories bound to their ports, the application services and the validated
 * settings. It imports everything it injects, so each side boots on its own (L-018). Not exported from `index.ts`.
 * Registers no model: the statements tables are read and written with SQL in `infra/` (they are all owned here).
 */
@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    InboxModule,
    JobsModule,
    OutboxModule,
    TenancyModule,
    StatementsReplicaModule,
    SequelizeModule.forFeature([]),
    EventsModule.forAggregates([STATEMENTS_AGGREGATE]),
    ProblemCatalogModule.forFeature(STATEMENTS_PROBLEMS),
  ],
  providers: [
    statementsConfigProvider,
    ConsumerLag,
    ReplicaReads,
    StatementsLifecycle,
    { provide: STOP_SIGNAL, useExisting: StatementsLifecycle },
    { provide: CLOSE_FAULT, useValue: {} },
    { provide: RECONCILE_FAULT, useValue: {} },
    { provide: RATE_REPOSITORY, useClass: SequelizeCommissionRateRepository },
    { provide: PERIOD_REPOSITORY, useClass: SequelizePeriodRepository },
    { provide: FACT_REPOSITORY, useClass: SequelizeFactRepository },
    { provide: SNAPSHOT_REPOSITORY, useClass: SequelizeSnapshotRepository },
    { provide: ADJUSTMENT_REPOSITORY, useClass: SequelizeAdjustmentRepository },
    { provide: STATEMENT_READER, useClass: SequelizeStatementReader },
    { provide: EXPORT_SOURCE, useClass: SequelizeExportSource },
    { provide: FINDING_REPOSITORY, useClass: SequelizeFindingRepository },
    { provide: SHOP_DIRECTORY, useClass: TenancyShopDirectoryAdapter },
    { provide: STREAM_LAG, useClass: KafkaStreamLag },
    CommissionRateService,
    CommissionRateQueryService,
    FactIngestionService,
    WatermarkService,
    StatementService,
    StatementExportService,
    PeriodCloseService,
    AdjustmentService,
    VerificationService,
    AccountingPeriodService,
  ],
  exports: [
    FINDING_REPOSITORY,
    VerificationService,
    EXPORT_SOURCE,
    StatementExportService,
    RECONCILE_FAULT,
    AdjustmentService,
    statementsConfigProvider,
    StatementsLifecycle,
    STOP_SIGNAL,
    CLOSE_FAULT,
    RATE_REPOSITORY,
    PERIOD_REPOSITORY,
    FACT_REPOSITORY,
    SNAPSHOT_REPOSITORY,
    ADJUSTMENT_REPOSITORY,
    STATEMENT_READER,
    SHOP_DIRECTORY,
    STREAM_LAG,
    CommissionRateService,
    CommissionRateQueryService,
    FactIngestionService,
    WatermarkService,
    StatementService,
    PeriodCloseService,
    AccountingPeriodService,
  ],
})
export class StatementsCoreModule {}
