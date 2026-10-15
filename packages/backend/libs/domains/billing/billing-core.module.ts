import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ProblemCatalogModule } from '@app/common/errors';
import { TenancyModule } from '@app/domains/tenancy';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { InboxModule } from '@app/infrastructure/inbox/inbox.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { AttemptResolutionService } from './application/attempt-resolution.service';
import { AttemptSettlement } from './application/attempt-settlement.service';
import { CancellationService } from './application/cancellation.service';
import { CatalogService } from './application/catalog.service';
import { ChangeService } from './application/change.service';
import { ChargeService } from './application/charge.service';
import {
  EntitlementsService,
  ShopEntitlementGuard,
} from './application/entitlements.service';
import { BILLING_AGGREGATE } from './application/events/billing-events';
import { InvoiceIssuer } from './application/invoice-issuer.service';
import { InvoiceQueryService } from './application/invoice-query.service';
import { PaymentMethodService } from './application/payment-method.service';
import { PlanTierService } from './application/plan-tier.service';
import { RENEWAL_FAULT, RenewalService } from './application/renewal.service';
import { SubscribeService } from './application/subscribe.service';
import { SubscriptionBasisService } from './application/subscription-basis.service';
import { SubscriptionQueryService } from './application/subscription-query.service';
import { SubscriptionTransitions } from './application/subscription-transitions.service';
import { TenancyLifecycleService } from './application/tenancy-lifecycle.service';
import { UsageService } from './application/usage.service';
import { BILLING_PROBLEMS } from './domain/errors';
import {
  BILLING_GATEWAY,
  CATALOG_REPOSITORY,
  INVOICE_REPOSITORY,
  PLAN_STATE_REPOSITORY,
  SHOP_DIRECTORY,
  STOP_SIGNAL,
  SUBSCRIPTION_REPOSITORY,
  USAGE_LINES_PROVIDER,
} from './domain/ports';
import { BillingLifecycle } from './infra/billing-lifecycle';
import { SequelizeCatalogRepository } from './infra/catalog.repository';
import { SequelizeInvoiceRepository } from './infra/invoice.repository';
import InvoiceLine from './infra/models/invoice-line.model';
import InvoiceTransition from './infra/models/invoice-transition.model';
import Invoice from './infra/models/invoice.model';
import Plan from './infra/models/plan.model';
import Price from './infra/models/price.model';
import SubjectPlanState from './infra/models/subject-plan-state.model';
import SubscriptionTransition from './infra/models/subscription-transition.model';
import Subscription from './infra/models/subscription.model';
import { SequelizePlanStateRepository } from './infra/plan-state.repository';
import { TenancyShopDirectoryAdapter } from './infra/shop-directory.adapter';
import {
  StripeBillingGateway,
  stripeTransportProvider,
} from './infra/stripe-billing-gateway';
import { SequelizeSubscriptionRepository } from './infra/subscription.repository';
import { UsageServiceLinesAdapter } from './infra/usage-lines.adapter';

/** Registered so the model registry knows the tables; the billing code itself reads and writes them with SQL. */
export const BILLING_MODELS = [
  Plan,
  Price,
  Subscription,
  Invoice,
  InvoiceLine,
  SubscriptionTransition,
  InvoiceTransition,
  SubjectPlanState,
];

/**
 * What the HTTP side (`BillingModule`), the background side (`BillingWorkerModule`) and the consumers
 * (`BillingConsumerModule`) share: repositories bound to their ports, the application services, the provider adapter
 * and S18's entitlement and usage services. It imports everything it injects, so each side boots on its own (L-018).
 * Not exported from `index.ts`.
 */
@Module({
  imports: [
    ClockModule,
    InboxModule,
    JobsModule,
    OutboxModule,
    TenancyModule,
    StripeModule,
    CacheModule,
    KafkaProducerModule,
    ClickHouseModule,
    SequelizeModule.forFeature(BILLING_MODELS),
    EventsModule.forAggregates([BILLING_AGGREGATE]),
    ProblemCatalogModule.forFeature(BILLING_PROBLEMS),
  ],
  providers: [
    BillingLifecycle,
    { provide: STOP_SIGNAL, useExisting: BillingLifecycle },
    { provide: RENEWAL_FAULT, useValue: {} },
    { provide: CATALOG_REPOSITORY, useClass: SequelizeCatalogRepository },
    {
      provide: SUBSCRIPTION_REPOSITORY,
      useClass: SequelizeSubscriptionRepository,
    },
    { provide: INVOICE_REPOSITORY, useClass: SequelizeInvoiceRepository },
    { provide: PLAN_STATE_REPOSITORY, useClass: SequelizePlanStateRepository },
    { provide: SHOP_DIRECTORY, useClass: TenancyShopDirectoryAdapter },
    stripeTransportProvider,
    { provide: BILLING_GATEWAY, useClass: StripeBillingGateway },
    { provide: USAGE_LINES_PROVIDER, useClass: UsageServiceLinesAdapter },
    PlanTierService,
    SubscriptionTransitions,
    InvoiceIssuer,
    CatalogService,
    SubscribeService,
    ChangeService,
    CancellationService,
    PaymentMethodService,
    RenewalService,
    ChargeService,
    AttemptSettlement,
    AttemptResolutionService,
    TenancyLifecycleService,
    InvoiceQueryService,
    SubscriptionQueryService,
    SubscriptionBasisService,
    // S18 (same domain, until S18 moves them)
    EntitlementsService,
    ShopEntitlementGuard,
    UsageService,
  ],
  exports: [
    STOP_SIGNAL,
    RENEWAL_FAULT,
    CATALOG_REPOSITORY,
    SUBSCRIPTION_REPOSITORY,
    INVOICE_REPOSITORY,
    PLAN_STATE_REPOSITORY,
    SHOP_DIRECTORY,
    BILLING_GATEWAY,
    USAGE_LINES_PROVIDER,
    BillingLifecycle,
    CatalogService,
    SubscribeService,
    ChangeService,
    CancellationService,
    PaymentMethodService,
    RenewalService,
    ChargeService,
    AttemptSettlement,
    AttemptResolutionService,
    TenancyLifecycleService,
    InvoiceQueryService,
    SubscriptionQueryService,
    SubscriptionBasisService,
    SubscriptionTransitions,
    EntitlementsService,
    ShopEntitlementGuard,
    UsageService,
  ],
})
export class BillingCoreModule {}
