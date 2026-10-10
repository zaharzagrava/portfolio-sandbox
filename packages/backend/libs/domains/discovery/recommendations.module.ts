import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { AuthModule } from '@app/domains/identity';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { RecommendationsController } from './api/recommendations.controller';
import { RecommendationsService } from './application/recommendations.service';
import {
  CATALOG_FACTS,
  NEIGHBOUR_LIST_READER,
} from './domain/recommendation-ports';
import { CatalogFactsAdapter } from './infra/catalog-facts.adapter';
import { RedisNeighbourListsAdapter } from './infra/redis-neighbour-lists.adapter';
import { RecommendationsSettings } from './infra/recommendations-config';
import { discoveryRatePolicies } from './rate-limit-policies';

/**
 * S34 read side (core): `GET /products/:productId/recommendations`. Product and shop facts come from the entry points of
 * `catalog` and `tenancy`, never from their tables (D-7, D-12). Exports nothing.
 */
@Module({
  imports: [
    AuthModule,
    ApiConfigModule,
    ProductModule,
    TenancyModule,
    RateLimitModule.forFeature(discoveryRatePolicies),
  ],
  controllers: [RecommendationsController],
  providers: [
    RecommendationsSettings,
    RecommendationsService,
    RedisNeighbourListsAdapter,
    { provide: NEIGHBOUR_LIST_READER, useExisting: RedisNeighbourListsAdapter },
    { provide: CATALOG_FACTS, useClass: CatalogFactsAdapter },
  ],
})
export class RecommendationsModule {}
