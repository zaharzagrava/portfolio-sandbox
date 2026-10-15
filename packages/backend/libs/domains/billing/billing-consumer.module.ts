import { Module } from '@nestjs/common';
import { InboxModule } from '@app/infrastructure/inbox/inbox.module';
import { BillingCoreModule } from './billing-core.module';
import {
  LlmUsageConsumer,
  SubscriptionStatusConsumer,
  UsageRecordedConsumer,
} from './infra/usage.consumers';
import {
  TenancyLifecycleConsumer,
  billingProjectors,
} from './infra/tenancy.consumers';

/**
 * The consumers (apps/projector): the shop lifecycle events from tenancy (S17 FR-048) and S18's three: usage reported
 * by the public API (`usage.recorded`), LLM metering (`llm.call_completed`) and the invalidation of cached
 * entitlements (`billing.subscription_status_changed`). Hosted as
 * `ProjectionsModule.forProjectors(BillingConsumerModule.projectors, [BillingConsumerModule])`.
 */
@Module({
  imports: [BillingCoreModule, InboxModule],
  providers: [
    TenancyLifecycleConsumer,
    SubscriptionStatusConsumer,
    UsageRecordedConsumer,
    LlmUsageConsumer,
  ],
  // the consumer host resolves the projectors' own dependencies through these
  exports: [
    BillingCoreModule,
    TenancyLifecycleConsumer,
    SubscriptionStatusConsumer,
    UsageRecordedConsumer,
    LlmUsageConsumer,
  ],
})
export class BillingConsumerModule {
  static readonly projectors = [
    ...billingProjectors,
    SubscriptionStatusConsumer,
    UsageRecordedConsumer,
    LlmUsageConsumer,
  ];
}
