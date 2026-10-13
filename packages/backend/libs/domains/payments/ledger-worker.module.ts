import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { PAYMENTS_AGGREGATE } from './application/events/payment-events';
import { LedgerModule } from './ledger.module';
import { LedgerProcessingModule } from './ledger-processing.module';
import Payout from './infra/models/payout.model';
import {
  PayoutProvider,
  StripeConnectPayoutProvider,
} from './infra/payout-provider.port';
import { PayoutJobs } from './infra/payout.jobs';
import { SettlementConsumer } from './infra/settlement.consumer';

/**
 * The ledger's background side (apps/worker): the settlement consumer, the reconciliation, housekeeping and payout
 * jobs. The ledger-owned providers come from `LedgerModule` and `LedgerProcessingModule`.
 */
@Module({
  imports: [
    LedgerModule,
    LedgerProcessingModule,
    StripeModule,
    EventsModule.forAggregates([PAYMENTS_AGGREGATE]),
    SequelizeModule.forFeature([Payout]),
    ProjectionsModule.forProjectors(
      [SettlementConsumer],
      [LedgerProcessingModule],
    ),
  ],
  providers: [
    { provide: PayoutProvider, useClass: StripeConnectPayoutProvider },
    PayoutJobs,
  ],
})
export class LedgerWorkerModule {}
