import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule, ApiConfigService } from '@app/common/config';
import { LoadTestPaymentProvider } from './infra/load-test-payment-provider';
import { ProblemCatalogModule } from '@app/common/errors';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';
import { PAYMENTS_PROBLEMS } from './domain/payment-errors';
import {
  LEDGER_POSTING,
  ORDER_COPY_REPOSITORY,
  PAYMENT_HISTORY_REPOSITORY,
  PAYMENT_PROVIDER,
  PAYMENT_REPOSITORY,
  RANDOM,
  REALTIME_PORT,
  REFRESH_GATE,
} from './domain/ports';
import { PAYMENT_MODELS } from './payments-models';
import { PAYMENTS_AGGREGATE } from './application/events/payment-events';
import { OrderCopyService } from './application/order-copy.service';
import { PaymentCancellationService } from './application/payment-cancellation.service';
import { PaymentChargeService } from './application/payment-charge.service';
import { PaymentIntentService } from './application/payment-intent.service';
import { PaymentRefundService } from './application/payment-refund.service';
import { PaymentResolutionService } from './application/payment-resolution.service';
import { PaymentTransitionService } from './application/payment-transition.service';
import { LedgerModule } from './ledger.module';
import { SequelizeOrderCopyRepository } from './infra/order-copy.repository';
import { SequelizePaymentHistoryRepository } from './infra/payment-history.repository';
import { SequelizePaymentRepository } from './infra/payment.repository';
import { LedgerPostingAdapter } from './infra/ledger-posting.adapter';
import { RedisRefreshGate } from './infra/redis-refresh-gate';
import { PaymentQueryService } from './application/payment-query.service';
import { RealtimeAdapter } from './infra/realtime.adapter';
import {
  PROVIDER_TRANSPORT,
  StripePaymentProvider,
} from './infra/stripe-payment-provider.adapter';

/**
 * Everything the HTTP side (`PaymentModule`) and the background side (`PaymentProcessorModule`) share: the repositories
 * and adapters bound to their ports, and the application services. One module, so the two sides never declare the
 * same provider twice (the pattern of `OrdersCoreModule`).
 */
@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    EventsModule.forAggregates([PAYMENTS_AGGREGATE]),
    JobsModule,
    RealtimeModule,
    StripeModule,
    LedgerModule,
    ProblemCatalogModule.forFeature(PAYMENTS_PROBLEMS),
    SequelizeModule.forFeature(PAYMENT_MODELS),
  ],
  providers: [
    { provide: PAYMENT_REPOSITORY, useClass: SequelizePaymentRepository },
    {
      provide: PAYMENT_HISTORY_REPOSITORY,
      useClass: SequelizePaymentHistoryRepository,
    },
    { provide: ORDER_COPY_REPOSITORY, useClass: SequelizeOrderCopyRepository },
    { provide: PROVIDER_TRANSPORT, useExisting: StripeService },
    StripePaymentProvider,
    LoadTestPaymentProvider,
    {
      // The load-test environment gets a provider that always succeeds; no other environment can reach it.
      provide: PAYMENT_PROVIDER,
      inject: [
        ApiConfigService,
        StripePaymentProvider,
        LoadTestPaymentProvider,
      ],
      useFactory: (
        config: ApiConfigService,
        stripe: StripePaymentProvider,
        loadTest: LoadTestPaymentProvider,
      ) => (config.get('is_load_test') ? loadTest : stripe),
    },
    { provide: LEDGER_POSTING, useClass: LedgerPostingAdapter },
    { provide: REALTIME_PORT, useClass: RealtimeAdapter },
    { provide: RANDOM, useValue: Math.random },
    { provide: REFRESH_GATE, useClass: RedisRefreshGate },
    OrderCopyService,
    PaymentTransitionService,
    PaymentChargeService,
    PaymentResolutionService,
    PaymentCancellationService,
    PaymentRefundService,
    PaymentQueryService,
    PaymentIntentService,
  ],
  exports: [
    SequelizeModule,
    PAYMENT_REPOSITORY,
    PAYMENT_HISTORY_REPOSITORY,
    ORDER_COPY_REPOSITORY,
    PAYMENT_PROVIDER,
    PROVIDER_TRANSPORT,
    LEDGER_POSTING,
    REALTIME_PORT,
    RANDOM,
    OrderCopyService,
    PaymentTransitionService,
    PaymentChargeService,
    PaymentResolutionService,
    PaymentCancellationService,
    PaymentRefundService,
    PaymentQueryService,
    PaymentIntentService,
  ],
})
export class PaymentsCoreModule {}
