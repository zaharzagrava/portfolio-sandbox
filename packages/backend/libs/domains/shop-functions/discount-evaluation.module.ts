import { Module } from '@nestjs/common';
import { BillingModule } from '@app/domains/billing';
import { ActiveSetService } from './application/active-set.service';
import { BreakerService } from './application/breaker.service';
import { DiscountEvaluationService } from './application/discount-evaluation.service';
import { SANDBOX, SHOP_FUNCTIONS_ENTITLEMENTS } from './domain/ports';
import { BillingEntitlementsAdapter } from './infra/billing-entitlements.adapter';
import { SandboxAdapter } from './infra/sandbox.adapter';
import { ShopFunctionsStoresModule } from './shop-functions-stores.module';

/**
 * Evaluation at checkout without any route (S45 FR-025): what orders imports, in every app that hosts checkout. The
 * sealed runtime is created lazily, so an app that never evaluates holds no isolate.
 */
@Module({
  imports: [BillingModule, ShopFunctionsStoresModule],
  providers: [
    BillingEntitlementsAdapter,
    SandboxAdapter,
    {
      provide: SHOP_FUNCTIONS_ENTITLEMENTS,
      useExisting: BillingEntitlementsAdapter,
    },
    { provide: SANDBOX, useExisting: SandboxAdapter },
    ActiveSetService,
    BreakerService,
    DiscountEvaluationService,
  ],
  exports: [DiscountEvaluationService, SHOP_FUNCTIONS_ENTITLEMENTS],
})
export class DiscountEvaluationModule {}
