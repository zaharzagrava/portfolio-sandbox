import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { AuthModule } from '@app/domains/identity';
import { ApiConfigModule } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { BalanceController } from './api/balance.controller';
import { ReconciliationController } from './api/reconciliation.controller';
import { BalanceQueryService } from './application/balance-query.service';
import { IssueResolutionService } from './application/issue-resolution.service';
import { LedgerService } from './application/ledger.service';
import { JournalPostingService } from './application/journal-posting.service';
import { PaymentPostingsService } from './application/payment-postings.service';
import { ReconciliationGauges } from './application/reconciliation-gauges.service';
import { ReconciliationQueryService } from './application/reconciliation-query.service';
import { LEDGER_PROBLEMS } from './domain/ledger-errors';
import {
  BALANCE_DURABLE_STORE,
  BALANCE_HOT_STORE,
  BALANCE_STORE,
  JOURNAL_STORE,
  PROJECTION_PROGRESS,
  PROVIDER_ACCOUNT_REPOSITORY,
  RECONCILIATION_STORE,
} from './domain/ledger-ports';
import { RedisProjectionProgress } from './infra/redis-job-support';
import { DynamoBalanceView } from './infra/balance-read-model.durable';
import { RedisBalanceHot } from './infra/balance-read-model.hot';
import { SequelizeBalanceStore } from './infra/balance.store';
import { SequelizeJournalStore } from './infra/journal.store';
import { SequelizeProviderAccountRepository } from './infra/provider-account.repository';
import { SequelizeReconciliationStore } from './infra/reconciliation.store';
import { LEDGER_MODELS } from './payments-models';
import { paymentsRatePolicies } from './rate-limit-policies';

/**
 * The ledger (S14): the posting path, the running balances, the balance read side, the operator API and the R1
 * service. Registers ledger models only: no `User`, `Payment`, `BisOrder` or `Shop` (S01 and S13 follow-ups,
 * FR-046). Hosted by core, worker and payment-processor.
 */
@Module({
  imports: [
    ApiConfigModule,
    AuthModule,
    ClockModule,
    DynamoModule,
    IdempotencyModule,
    RedisModule,
    SequelizeModule.forFeature(LEDGER_MODELS),
    EventsModule.forAggregates([
      { aggregateType: 'ledger', retention: 'full-history' },
    ]),
    ProblemCatalogModule.forFeature(LEDGER_PROBLEMS),
    RateLimitModule.forFeature(paymentsRatePolicies),
  ],
  controllers: [BalanceController, ReconciliationController],
  providers: [
    { provide: JOURNAL_STORE, useClass: SequelizeJournalStore },
    { provide: BALANCE_STORE, useClass: SequelizeBalanceStore },
    { provide: BALANCE_HOT_STORE, useClass: RedisBalanceHot },
    { provide: BALANCE_DURABLE_STORE, useClass: DynamoBalanceView },
    { provide: RECONCILIATION_STORE, useClass: SequelizeReconciliationStore },
    { provide: PROJECTION_PROGRESS, useClass: RedisProjectionProgress },
    {
      provide: PROVIDER_ACCOUNT_REPOSITORY,
      useClass: SequelizeProviderAccountRepository,
    },
    JournalPostingService,
    PaymentPostingsService,
    BalanceQueryService,
    ReconciliationGauges,
    ReconciliationQueryService,
    IssueResolutionService,
    LedgerService,
  ],
  exports: [
    LedgerService,
    JOURNAL_STORE,
    BALANCE_STORE,
    BALANCE_HOT_STORE,
    BALANCE_DURABLE_STORE,
    RECONCILIATION_STORE,
    PROJECTION_PROGRESS,
    PROVIDER_ACCOUNT_REPOSITORY,
    JournalPostingService,
    PaymentPostingsService,
    BalanceQueryService,
    ReconciliationGauges,
  ],
})
export class LedgerModule {}
