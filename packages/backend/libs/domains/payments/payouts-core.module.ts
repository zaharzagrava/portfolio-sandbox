import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { TenancyModule } from '@app/domains/tenancy';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { PAYOUTS_AGGREGATE } from './application/events/payout-events';
import { PayoutAuditService } from './application/payout-audit.service';
import { PayoutCancelService } from './application/payout-cancel.service';
import { PayoutCreationService } from './application/payout-creation.service';
import { PayoutDestinationService } from './application/payout-destination.service';
import { PayoutQueryService } from './application/payout-query.service';
import { PayoutReserveService } from './application/payout-reserve.service';
import { PayoutResolverService } from './application/payout-resolver.service';
import { PayoutRunService } from './application/payout-run.service';
import { PayoutTransferService } from './application/payout-transfer.service';
import { PayoutTransitionService } from './application/payout-transition.service';
import { PAYOUT_PROBLEMS } from './domain/payout-errors';
import {
  PAYOUT_AUDIT_REPOSITORY,
  PAYOUT_DESTINATION_REPOSITORY,
  PAYOUT_EVENTS,
  PAYOUT_JOBS,
  PAYOUT_LEDGER,
  PAYOUT_PROVIDER,
  PAYOUT_REPOSITORY,
  PAYOUT_RESERVE_REPOSITORY,
  PAYOUT_RUN_REPOSITORY,
  SHOP_SUMMARY_PORT,
} from './domain/payout-ports';
import { RANDOM } from './domain/ports';
import { JobsPayoutAdapter } from './infra/jobs-payout.adapter';
import { LedgerPayoutAdapter } from './infra/ledger-payout.adapter';
import { OutboxPayoutEvents } from './infra/outbox-payout-events.adapter';
import { SequelizePayoutAuditRepository } from './infra/payout-audit.repository';
import { SequelizePayoutDestinationRepository } from './infra/payout-destination.repository';
import { SequelizePayoutReserveRepository } from './infra/payout-reserve.repository';
import { SequelizePayoutRunRepository } from './infra/payout-run.repository';
import { SequelizePayoutRepository } from './infra/payout.repository';
import { StripePayoutProviderAdapter } from './infra/stripe-payout-provider.adapter';
import { TenancyShopSummaryAdapter } from './infra/tenancy-shop-summary.adapter';
import { LedgerModule } from './ledger.module';
import { PAYOUT_MODELS } from './payments-models';

/**
 * What the HTTP side (`PayoutsModule`) and the background side (`PayoutsWorkerModule`) share: the payout tables, the
 * repositories and adapters bound to their ports, and the application services (the pattern of `PaymentsCoreModule`).
 * It imports everything it injects, so each side boots on its own (L-018). Registers payout models only: no `Shop`,
 * no `Payment`, no ledger model.
 */
@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    JobsModule,
    OutboxModule,
    StripeModule,
    TenancyModule,
    LedgerModule,
    EventsModule.forAggregates([PAYOUTS_AGGREGATE]),
    ProblemCatalogModule.forFeature(PAYOUT_PROBLEMS),
    SequelizeModule.forFeature(PAYOUT_MODELS),
  ],
  providers: [
    { provide: PAYOUT_REPOSITORY, useClass: SequelizePayoutRepository },
    { provide: PAYOUT_RUN_REPOSITORY, useClass: SequelizePayoutRunRepository },
    {
      provide: PAYOUT_DESTINATION_REPOSITORY,
      useClass: SequelizePayoutDestinationRepository,
    },
    {
      provide: PAYOUT_RESERVE_REPOSITORY,
      useClass: SequelizePayoutReserveRepository,
    },
    {
      provide: PAYOUT_AUDIT_REPOSITORY,
      useClass: SequelizePayoutAuditRepository,
    },
    { provide: SHOP_SUMMARY_PORT, useClass: TenancyShopSummaryAdapter },
    { provide: PAYOUT_LEDGER, useClass: LedgerPayoutAdapter },
    { provide: PAYOUT_PROVIDER, useClass: StripePayoutProviderAdapter },
    { provide: PAYOUT_JOBS, useClass: JobsPayoutAdapter },
    { provide: PAYOUT_EVENTS, useClass: OutboxPayoutEvents },
    { provide: RANDOM, useValue: Math.random },
    PayoutTransitionService,
    PayoutCreationService,
    PayoutRunService,
    PayoutTransferService,
    PayoutResolverService,
    PayoutCancelService,
    PayoutDestinationService,
    PayoutReserveService,
    PayoutQueryService,
    PayoutAuditService,
  ],
  exports: [
    SequelizeModule,
    PAYOUT_REPOSITORY,
    PAYOUT_PROVIDER,
    PAYOUT_LEDGER,
    PAYOUT_DESTINATION_REPOSITORY,
    PAYOUT_RESERVE_REPOSITORY,
    SHOP_SUMMARY_PORT,
    PayoutTransitionService,
    PayoutCreationService,
    PayoutRunService,
    PayoutTransferService,
    PayoutResolverService,
    PayoutCancelService,
    PayoutDestinationService,
    PayoutReserveService,
    PayoutQueryService,
    PayoutAuditService,
  ],
})
export class PayoutsCoreModule {}
