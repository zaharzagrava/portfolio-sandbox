import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EntitlementGuardValidator } from './application/entitlement.guard';
import { AuthModule } from '@app/domains/identity';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { AdminBillingController } from './api/admin-billing.controller';
import { BillingApi } from './api/billing-api.service';
import { BuyerSubscriptionController } from './api/buyer-subscription.controller';
import { PlansController } from './api/plans.controller';
import { ShopSubscriptionController } from './api/shop-subscription.controller';
import { UsageController } from './api/usage.controller';
import { BillingCoreModule } from './billing-core.module';
import { billingRatePolicies } from './rate-limit-policies';

/**
 * HTTP side (apps/core): the catalog, the operator's catalog API and the subscription routes of shops and buyers
 * (S17 contracts/http.md) and S18's usage read. Not global (X.4): a module that asks what a plan allows
 * (`EntitlementsService`, `@RequiresShopEntitlement`) imports this module, which re-exports the shared core. The
 * start-up check of the entitlement guard lives here, so it sees every controller of the application. The product
 * catalog imports it for the plan limit of a create (J02 FR-010).
 */
@Module({
  imports: [
    DiscoveryModule,
    BillingCoreModule,
    AuthModule,
    IdempotencyModule,
    RateLimitModule.forFeature(billingRatePolicies),
  ],
  controllers: [
    PlansController,
    AdminBillingController,
    ShopSubscriptionController,
    BuyerSubscriptionController,
    UsageController,
  ],
  providers: [BillingApi, EntitlementGuardValidator],
  exports: [BillingCoreModule],
})
export class BillingModule {}
