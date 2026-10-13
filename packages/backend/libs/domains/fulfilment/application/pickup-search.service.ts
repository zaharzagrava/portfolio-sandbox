import { Inject, Injectable } from '@nestjs/common';
import type {
  PickupBrowseQuery,
  PickupClusterQuery,
  PickupClustersResponse,
  PickupNearSearchResponse,
  PickupPointsNearResponse,
  PickupSearchQuery,
} from '@marketplace-sandbox/contracts';
import { capClusterCells } from '../domain/cluster-cap';
import {
  PICKUP_AVAILABILITY_INDEX,
  PICKUP_BROWSE_READER,
  type PickupAvailabilityIndex,
  type PickupBrowseReader,
} from '../domain/pickup-ports';
import {
  PickupValidationError,
  SearchUnavailableError,
  ServiceUnavailableError,
} from '../domain/pickup-errors';
import { decodeCursor, encodeCursor, queryKey } from '../domain/search-cursor';
import { PickupMetrics } from '../infra/pickup-metrics';

type Endpoint = 'search' | 'browse' | 'clusters';

/**
 * Shopper reads (S19 FR-020..FR-027). Search and clusters ask the index only and answer `503 search_unavailable` when it
 * fails: there is no fallback to the exact store. The browse asks the exact store, bounded by its statement limit.
 * Cursors are bound to the normalised query, so a cursor of another query is refused.
 */
@Injectable()
export class PickupSearchService {
  constructor(
    @Inject(PICKUP_AVAILABILITY_INDEX)
    private readonly index: PickupAvailabilityIndex,
    @Inject(PICKUP_BROWSE_READER) private readonly reader: PickupBrowseReader,
  ) {}

  /** `GET /search/near`: one item per product with its nearest in-stock point. */
  searchNear(query: PickupSearchQuery): Promise<PickupNearSearchResponse> {
    return this.measured('search', async () => {
      const key = queryKey({
        kind: 'search',
        q: query.q ?? null,
        lat: query.lat,
        lng: query.lng,
        radiusKm: query.radiusKm,
      });
      const after = query.cursor ? decodeCursor(query.cursor, key) : null;
      if (query.cursor && !after) throw new PickupValidationError(['cursor']);
      const page = await this.index.search({
        lat: query.lat,
        lng: query.lng,
        radiusKm: query.radiusKm,
        q: query.q,
        limit: query.limit,
        after,
      });
      return {
        items: page.items,
        nextCursor: page.next ? encodeCursor(page.next, key) : null,
      };
    });
  }

  /** `GET /pickup-points/near`: the exact store, nearest first. */
  browse(query: PickupBrowseQuery): Promise<PickupPointsNearResponse> {
    return this.measured('browse', async () => {
      const key = queryKey({
        kind: 'browse',
        lat: query.lat,
        lng: query.lng,
        radiusKm: query.radiusKm,
        productId: query.productId ?? null,
      });
      let after: [number, string] | null = null;
      if (query.cursor) {
        const tuple = decodeCursor(query.cursor, key);
        if (
          !tuple ||
          typeof tuple[0] !== 'number' ||
          typeof tuple[1] !== 'string'
        )
          throw new PickupValidationError(['cursor']);
        after = [tuple[0], tuple[1]];
      }
      const rows = await this.reader.browse({
        lat: query.lat,
        lng: query.lng,
        radiusKm: query.radiusKm,
        productId: query.productId,
        limit: query.limit + 1,
        after,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(({ sortDistance: _unused, ...item }) => item),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.sortDistance, last.id], key)
            : null,
      };
    });
  }

  /** `GET /pickup-points/clusters`: zoom-dependent cells of the viewport, at most 500. */
  clusters(query: PickupClusterQuery): Promise<PickupClustersResponse> {
    return this.measured('clusters', async () => {
      const found = await this.index.clusters({
        bbox: query.bbox,
        zoom: query.zoom,
        productId: query.productId,
      });
      return capClusterCells(found.cells, found.omittedByEngine);
    });
  }

  private async measured<T>(
    endpoint: Endpoint,
    run: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    const record = (outcome: 'ok' | 'unavailable') =>
      PickupMetrics.searchDuration.record(
        (performance.now() - started) / 1000,
        {
          endpoint,
          outcome,
        },
      );
    try {
      const result = await run();
      record('ok');
      return result;
    } catch (error) {
      if (
        error instanceof SearchUnavailableError ||
        error instanceof ServiceUnavailableError
      ) {
        record('unavailable');
        PickupMetrics.rejections.add(1, { endpoint, code: '503' });
      }
      throw error;
    }
  }
}
