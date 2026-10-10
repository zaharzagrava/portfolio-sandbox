import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Payout from './infra/models/payout.model';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { LedgerModule } from './ledger.module';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { PAYMENTS_AGGREGATE } from './application/events/payment-events';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import {
  PayoutProvider,
  StripeConnectPayoutProvider,
} from './infra/payout-provider.port';
import { PayoutJobs } from './infra/payout.jobs';
import { ReconciliationJobs } from './infra/reconciliation.jobs';
import { LedgerMaintenanceJobs } from './infra/ledger-maintenance.jobs';
import { SettlementListener } from './infra/settlement.listener';

/** SD-20 background side (apps/worker). */
@Module({
  imports: [
    LedgerModule,
    StripeModule,
    EventsModule.forAggregates([PAYMENTS_AGGREGATE]),
    SequelizeModule.forFeature([Payout, Shop]),
    ProjectionsModule.forProjectors([SettlementListener], [LedgerModule]),
  ],
  providers: [
    { provide: PayoutProvider, useClass: StripeConnectPayoutProvider },
    PayoutJobs,
    ReconciliationJobs,
    LedgerMaintenanceJobs,
  ],
})
export class FinanceWorkerModule {}
