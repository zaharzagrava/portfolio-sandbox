import { Module } from '@nestjs/common';
import { InboxModule } from '@app/infrastructure/inbox/inbox.module';
import { BillingCoreModule } from './billing-core.module';
import {
  TenancyLifecycleConsumer,
  billingProjectors,
} from './infra/tenancy.consumers';

/**
 * The consumers (apps/projector): the shop lifecycle events from tenancy (S17 FR-048). Hosted as
 * `ProjectionsModule.forProjectors(BillingConsumerModule.projectors, [BillingConsumerModule])`.
 */
@Module({
  imports: [BillingCoreModule, InboxModule],
  providers: [TenancyLifecycleConsumer],
  // the consumer host resolves the projectors' own dependencies through these
  exports: [BillingCoreModule, TenancyLifecycleConsumer],
})
export class BillingConsumerModule {
  static readonly projectors = billingProjectors;
}
