import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Payout from './infra/models/payout.model';
import { ShopModel as Shop } from '@app/domains/tenancy';
import Payment from './infra/models/payment.model';
import { LedgerModule } from './ledger.module';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { PayoutProvider, StripeConnectPayoutProvider } from './infra/payout-provider.port';
import { PayoutJobs } from './infra/payout.jobs';
import { PaymentResolutionJobs } from './infra/payment-resolution.jobs';
import { ReconciliationJobs } from './infra/reconciliation.jobs';
import { LedgerMaintenanceJobs } from './infra/ledger-maintenance.jobs';
import { SettlementListener } from './infra/settlement.listener';

/** SD-20 background side (apps/worker). */
@Module({
  imports: [
    LedgerModule,
    StripeModule,
    OutboxModule,
    SequelizeModule.forFeature([Payout, Shop, Payment]),
    ProjectionsModule.forProjectors([SettlementListener], [LedgerModule]),
  ],
  providers: [{ provide: PayoutProvider, useClass: StripeConnectPayoutProvider }, PayoutJobs, PaymentResolutionJobs, ReconciliationJobs, LedgerMaintenanceJobs],
})
export class FinanceWorkerModule {}
