import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors/problem-catalog.module';
import { AuthModule } from '@app/domains/identity';
import { TenancyModule } from '@app/domains/tenancy';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { FunctionVersionsController } from './api/function-versions.controller';
import { shopFunctionsRatePolicies } from './api/rate-limit-policies';
import { ShopFunctionsController } from './api/shop-functions.controller';
import { EntitlementGate } from './application/entitlement-gate';
import { FunctionsService } from './application/functions.service';
import { VersionsService } from './application/versions.service';
import { SHOP_FUNCTION_PROBLEMS } from './domain/errors';
import { DiscountEvaluationModule } from './discount-evaluation.module';
import { ShopFunctionsStoresModule } from './shop-functions-stores.module';

/**
 * Core (apps/core): the management and version routes (S45 plan). Declares its own imports (L-018) and is not
 * `@Global()`; evaluation at checkout is `DiscountEvaluationModule`'s, which orders imports.
 */
@Module({
  imports: [
    AuthModule,
    TenancyModule,
    DiscountEvaluationModule,
    ShopFunctionsStoresModule,
    RateLimitModule.forFeature(shopFunctionsRatePolicies),
    ProblemCatalogModule.forFeature(SHOP_FUNCTION_PROBLEMS),
  ],
  providers: [EntitlementGate, FunctionsService, VersionsService],
  controllers: [ShopFunctionsController, FunctionVersionsController],
})
export class ShopFunctionsModule {}
