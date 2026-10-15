import { Module } from '@nestjs/common';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { PAYMENTS_AGGREGATE } from './application/events/payment-events';
import { LedgerModule } from './ledger.module';
import { LedgerProcessingModule } from './ledger-processing.module';
import { SettlementConsumer } from './infra/settlement.consumer';

/**
 * The ledger's background side (apps/worker): the settlement consumer and the reconciliation and housekeeping jobs.
 * The ledger-owned providers come from `LedgerModule` and `LedgerProcessingModule`. The payout jobs moved to
 * `PayoutsWorkerModule` (S15).
 */
@Module({
  imports: [
    LedgerModule,
    LedgerProcessingModule,
    StripeModule,
    EventsModule.forAggregates([PAYMENTS_AGGREGATE]),
    ProjectionsModule.forProjectors(
      [SettlementConsumer],
      [LedgerProcessingModule],
    ),
  ],
})
export class LedgerWorkerModule {}
