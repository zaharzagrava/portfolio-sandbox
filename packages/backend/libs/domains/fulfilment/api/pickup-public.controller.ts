import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  pickupBrowseQuerySchema,
  pickupClusterQuerySchema,
  pickupSearchQuerySchema,
  type PickupBrowseQuery,
  type PickupClusterQuery,
  type PickupClustersResponse,
  type PickupNearSearchResponse,
  type PickupPointsNearResponse,
  type PickupSearchQuery,
} from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { PickupSearchService } from '../application/pickup-search.service';
import { PickupZodPipe } from './pickup-zod.pipe';

const searchQuery = new PickupZodPipe(pickupSearchQuerySchema);
const browseQuery = new PickupZodPipe(pickupBrowseQuerySchema);
const clusterQuery = new PickupZodPipe(pickupClusterQuerySchema);

/** What a CDN may keep of a map answer (S19 FR-027): 30 seconds, success only. */
const CLUSTERS_CACHEABLE = 'public, s-maxage=30';

/**
 * Shopper reads (S19 FR-020..FR-027): anonymous, rate limited by `fulfilment.near-search` (search and browse) and
 * `fulfilment.map-clusters`, strict query parsing, one service call per method. Every answer is `no-store` (the
 * results depend on the shopper's position) until a clusters body is complete; errors keep `no-store`.
 */
@ApiTags('pickup')
@Controller()
export class PickupPublicController {
  constructor(private readonly search: PickupSearchService) {}

  /** "AirPods available for pickup within 5 km": the search index, eventually consistent. */
  @Firewall({ anonymous: true })
  @RateLimit('fulfilment.near-search')
  @Get('search/near')
  searchNear(
    @Query(searchQuery) query: PickupSearchQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PickupNearSearchResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.search.searchNear(query);
  }

  /** Pickup points within a radius, nearest first: the exact store, never stale. */
  @Firewall({ anonymous: true })
  @RateLimit('fulfilment.near-search')
  @Get('pickup-points/near')
  browse(
    @Query(browseQuery) query: PickupBrowseQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PickupPointsNearResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.search.browse(query);
  }

  /** Map cells of the viewport at a zoom. */
  @Firewall({ anonymous: true })
  @RateLimit('fulfilment.map-clusters')
  @Get('pickup-points/clusters')
  async clusters(
    @Query(clusterQuery) query: PickupClusterQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PickupClustersResponse> {
    res.setHeader('Cache-Control', 'no-store');
    const body = await this.search.clusters(query);
    res.setHeader('Cache-Control', CLUSTERS_CACHEABLE);
    return body;
  }
}
