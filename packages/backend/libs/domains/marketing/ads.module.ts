import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors/problem-catalog.module';
import { AuthModule } from '@app/domains/identity';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { AdsController } from './api/ads.controller';
import { AdsStoresModule } from './ads-stores.module';
import { BillingStatementService } from './application/billing-statement.service';
import { CampaignCommandService } from './application/campaign-command.service';
import { CampaignLifecycleService } from './application/campaign-lifecycle.service';
import { CampaignQueryService } from './application/campaign-query.service';
import { MARKETING_AGGREGATE } from './application/events/ads-events';
import { ClickService } from './application/click.service';
import { ServingService } from './application/serving.service';
import { CATALOG_PORT, SHOP_DIRECTORY_PORT } from './domain/ads-ports';
import { ADS_PROBLEMS } from './domain/ads-errors';
import { CatalogAdapter } from './infra/catalog.adapter';
import { ShopDirectoryAdapter } from './infra/shop-directory.adapter';
import { marketingRatePolicies } from './rate-limit-policies';

/**
 * Sponsored listings, HTTP side (S36, apps/core): campaign management, the billing statement, the public slots endpoint
 * and the click redirect. Explicit imports for everything it injects (L6); the stores sit behind port tokens, the R1
 * lookups (catalog, tenancy) behind adapters.
 */
@Module({
  imports: [
    AuthModule,
    ClockModule,
    AdsStoresModule,
    ProductModule,
    TenancyModule,
    EventsModule.forAggregates([MARKETING_AGGREGATE]),
    ProblemCatalogModule.forFeature(ADS_PROBLEMS),
    RateLimitModule.forFeature(marketingRatePolicies),
  ],
  providers: [
    CampaignLifecycleService,
    CampaignCommandService,
    CampaignQueryService,
    BillingStatementService,
    ServingService,
    ClickService,
    CatalogAdapter,
    ShopDirectoryAdapter,
    { provide: CATALOG_PORT, useExisting: CatalogAdapter },
    { provide: SHOP_DIRECTORY_PORT, useExisting: ShopDirectoryAdapter },
  ],
  controllers: [AdsController],
})
export class AdsModule {}
