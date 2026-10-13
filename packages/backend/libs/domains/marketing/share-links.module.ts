import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors/problem-catalog.module';
import { AuthModule } from '@app/domains/identity';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { ShareLinksController } from './api/share-links.controller';
import { LinkAttributionService } from './application/link-attribution.service';
import { RedirectService } from './application/redirect.service';
import { ShareLinkCommandService } from './application/share-link-command.service';
import { ShareLinkQueryService } from './application/share-link-query.service';
import { SHARE_LINK_PROBLEMS } from './domain/link-errors';
import { marketingRatePolicies } from './rate-limit-policies';
import { ShareLinksStoresModule } from './share-links-stores.module';

/**
 * Share and affiliate links, HTTP side (S37, apps/core): create, redirect, list, change, disable and statistics, plus
 * the R1 attribution lookup. Explicit imports for everything it injects (L6); the stores sit behind port tokens.
 */
@Module({
  imports: [
    AuthModule,
    IdempotencyModule,
    ShareLinksStoresModule,
    ProblemCatalogModule.forFeature(SHARE_LINK_PROBLEMS),
    RateLimitModule.forFeature(marketingRatePolicies),
  ],
  providers: [
    ShareLinkCommandService,
    ShareLinkQueryService,
    RedirectService,
    LinkAttributionService,
  ],
  controllers: [ShareLinksController],
  exports: [LinkAttributionService],
})
export class ShareLinksModule {}
