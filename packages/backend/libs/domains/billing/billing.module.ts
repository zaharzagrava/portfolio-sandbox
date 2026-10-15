import { Global, Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { AdminBillingController } from './api/admin-billing.controller';
import { BillingApi } from './api/billing-api.service';
import { BuyerSubscriptionController } from './api/buyer-subscription.controller';
import { PlansController } from './api/plans.controller';
import { ShopSubscriptionController } from './api/shop-subscription.controller';
import { BillingCoreModule } from './billing-core.module';
import { billingRatePolicies } from './rate-limit-policies';

/**
 * HTTP side (apps/core): the catalog, the operator's catalog API and the subscription routes of shops and buyers
 * (S17 contracts/http.md). Global: other domains read entitlements (`@RequiresShopEntitlement`) and record usage
 * (S18) through the services this module re-exports from the shared core.
 */
@Global()
@Module({
  imports: [
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
  ],
  providers: [BillingApi],
  exports: [BillingCoreModule],
})
export class BillingModule {}
