import { Injectable, Logger } from '@nestjs/common';
import type {
  PickupClusterCell,
  PickupNearItem,
} from '@marketplace-sandbox/contracts';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import type {
  ClusterParams,
  PickupAvailabilityIndex,
  SearchPage,
  SearchParams,
} from '../domain/pickup-ports';
import type { OfferWrite } from '../domain/offer-document';
import { SearchUnavailableError } from '../domain/pickup-errors';
import type { CursorValue } from '../domain/search-cursor';
import { PickupMetrics } from './pickup-metrics';
import { shardName } from '@app/common/shard';

/**
 * The pickup index is private to this capability: nobody else reads or writes it and it shares no filter with the
 * product index (S19 A13, D-16). The `_v2` suffix marks the mapping of data-model.md; the draft's index of the same
 * family keeps its old mapping and is simply no longer used.
 */
export const AVAILABILITY_INDEX = shardName('pickup_availability_v2');

/** Search and cluster reads are latency bound: one attempt, 800 ms (S19 FR-024). */
export const READ_TIMEOUT_MS = 800;
const WRITE_TIMEOUT_MS = 5_000;
/** Cells the engine is asked for per map request (the answer keeps 500 of them). */
const CLUSTER_WINDOW = 5_000;
/** Batches a search page may read to find its products (each product has a few documents at most). */
const MAX_ROUNDS = 6;

const MAPPING = {
  // gc_deletes: versioned-delete tombstones are kept this long, so an older write arriving later than that could
  // re-create a deleted document - 1 h covers realistic redelivery lag. One shard: relevance scores of the documents
  // of one product must be equal for "nearest document first" to be the product's order.
  settings: {
    number_of_shards: 1,
    refresh_interval: '2s',
    'index.gc_deletes': '1h',
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      productId: { type: 'keyword' },
      pickupPointId: { type: 'keyword' },
      shopId: { type: 'keyword' },
      title: {
        type: 'text',
        analyzer: 'english',
        fields: { raw: { type: 'keyword' } },
      },
      category: { type: 'keyword' },
      priceMinor: { type: 'long' },
      currency: { type: 'keyword' },
      pointName: { type: 'keyword', index: false, doc_values: false },
      pointAddress: { type: 'keyword', index: false, doc_values: false },
      quantity: { type: 'integer' },
      location: { type: 'geo_point' },
      pointActive: { type: 'boolean' },
      isSandbox: { type: 'boolean' },
      productStatus: { type: 'keyword' },
      shopStatus: { type: 'keyword' },
      stockVersion: { type: 'long' },
      pointVersion: { type: 'long' },
      productVersion: { type: 'long' },
      shopVersion: { type: 'long' },
      docVersion: { type: 'long' },
    },
  },
};

interface EngineHit {
  _id: string;
  _source: Record<string, unknown>;
  sort?: CursorValue[];
  inner_hits?: {
    nearest: {
      hits: { hits: { _source: Record<string, unknown>; sort?: number[] }[] };
    };
  };
}

@Injectable()
export class PickupAvailabilityIndexAdapter implements PickupAvailabilityIndex {
  private readonly logger = new Logger(PickupAvailabilityIndexAdapter.name);

  constructor(private readonly engine: SearchEngineClient) {}

  async ensureIndex(): Promise<void> {
    if (await this.engine.indexExists(AVAILABILITY_INDEX, { maxRetries: 1 }))
      return;
    const created = await this.engine.createIndex(AVAILABILITY_INDEX, MAPPING);
    this.logger.log(
      created
        ? `index ${AVAILABILITY_INDEX} created`
        : `index ${AVAILABILITY_INDEX} present`,
    );
  }

  /** The engine failed or ran over its budget: log why (no query, no coordinates) and answer the one 503. */
  private unavailable(call: string, error: unknown): never {
    this.logger.warn(
      `pickup index ${call} failed: ${(error as Error).message}`,
    );
    throw new SearchUnavailableError();
  }

  /**
   * One item per product with its nearest in-stock point, ordered by relevance then distance (with `q`) or by distance,
   * then `productId` and `pickupPointId` (a total order), resumed with `search_after`.
   *
   * The engine refuses `collapse` together with `search_after` on another sort, so the dedupe is done here: documents
   * are read in sort order after the cursor, and a document is a product's item only if no document of the same product
   * sorts before it. That is asked of the engine for the products of each batch (one `collapse` query without
   * `search_after`, which returns each product's first document). The first document of a product in the sort order is
   * its nearest point, so the result is the same as collapsing, and a product shown on an earlier page never returns.
   */
  async search(params: SearchParams): Promise<SearchPage> {
    const origin = { lat: params.lat, lon: params.lng };
    const distance = {
      _geo_distance: { location: origin, order: 'asc', unit: 'm' },
    };
    const sort = params.q
      ? ['_score', distance, { productId: 'asc' }, { pickupPointId: 'asc' }]
      : [distance, { productId: 'asc' }, { pickupPointId: 'asc' }];
    const distanceAt = params.q ? 1 : 0;
    const base = {
      index: AVAILABILITY_INDEX,
      track_total_hits: false,
      sort,
    };
    const bool = (extra: object[] = []) => ({
      bool: {
        ...(params.q && {
          must: [
            {
              match: {
                title: { query: params.q, fuzziness: 'AUTO', operator: 'and' },
              },
            },
          ],
        }),
        filter: [
          {
            geo_distance: {
              distance: `${params.radiusKm}km`,
              location: origin,
            },
          },
          { range: { quantity: { gt: 0 } } },
          ...extra,
        ],
      },
    });
    const batchSize = Math.min(150, (params.limit + 1) * 3);
    const emitted: { item: PickupNearItem; sort: CursorValue[] }[] = [];
    let after: CursorValue[] | null = params.after;
    let exhausted = false;
    let lastExamined: CursorValue[] | null = null;
    try {
      for (
        let round = 0;
        round < MAX_ROUNDS && emitted.length <= params.limit;
        round++
      ) {
        const batch: { hits: { hits: EngineHit[] } } = await this.engine.search(
          {
            ...base,
            size: batchSize,
            query: bool(),
            ...(after && { search_after: after }),
          },
          { timeoutMs: READ_TIMEOUT_MS, maxRetries: 0 },
        );
        const docs = batch.hits.hits;
        if (docs.length === 0) {
          exhausted = true;
          break;
        }
        const ids = [...new Set(docs.map((d) => String(d._source.productId)))];
        const firsts: {
          hits: { hits: { _id: string; _source: Record<string, unknown> }[] };
        } = await this.engine.search(
          {
            ...base,
            size: ids.length,
            query: bool([{ terms: { productId: ids } }]),
            collapse: { field: 'productId' },
          },
          { timeoutMs: READ_TIMEOUT_MS, maxRetries: 0 },
        );
        const bestDoc = new Map(
          firsts.hits.hits.map((h) => [String(h._source.productId), h._id]),
        );
        for (const doc of docs) {
          if (bestDoc.get(String(doc._source.productId)) !== doc._id) continue;
          const src = doc._source as Record<string, string | number>;
          emitted.push({
            sort: doc.sort ?? [],
            item: {
              productId: String(src.productId),
              title: String(src.title),
              category: String(src.category),
              priceMinor: Number(src.priceMinor),
              currency: String(src.currency),
              nearest: {
                pickupPointId: String(src.pickupPointId),
                name: String(src.pointName),
                distanceM: Math.round(Number(doc.sort?.[distanceAt] ?? 0)),
                quantity: Number(src.quantity),
              },
            },
          });
        }
        lastExamined = docs[docs.length - 1].sort ?? null;
        after = lastExamined;
        if (docs.length < batchSize) {
          exhausted = true;
          break;
        }
      }
    } catch (error) {
      this.unavailable('search', error);
    }
    const page = emitted.slice(0, params.limit);
    const more = emitted.length > params.limit;
    return {
      items: page.map((e) => e.item),
      // more products wait after the last one shown; or the rounds ran out before the end of the documents
      next: more
        ? page[page.length - 1].sort
        : !exhausted && lastExamined
          ? lastExamined
          : null,
    };
  }

  async clusters(params: ClusterParams): Promise<{
    cells: PickupClusterCell[];
    omittedByEngine: boolean;
  }> {
    const { bbox } = params;
    let res: { aggregations?: Record<string, unknown> };
    try {
      res = await this.engine.search(
        {
          index: AVAILABILITY_INDEX,
          size: 0,
          track_total_hits: false,
          query: {
            bool: {
              filter: [
                {
                  geo_bounding_box: {
                    location: {
                      top_left: { lat: bbox.top, lon: bbox.left },
                      bottom_right: { lat: bbox.bottom, lon: bbox.right },
                    },
                  },
                },
                { range: { quantity: { gt: 0 } } },
                ...(params.productId
                  ? [{ term: { productId: params.productId } }]
                  : []),
              ],
            },
          },
          aggs: {
            cells: {
              // A window wider than the 500 cells of the answer: the cut at 500 (offers descending, equal offers by
              // cellId) is made by `capClusterCells`, so it is exact while the viewport holds at most this many
              // cells; beyond that the engine's own order decides among cells with equal offers.
              geotile_grid: {
                field: 'location',
                precision: params.zoom,
                size: CLUSTER_WINDOW,
              },
              aggs: {
                center: { geo_centroid: { field: 'location' } },
                points: {
                  cardinality: {
                    field: 'pickupPointId',
                    precision_threshold: 1000,
                  },
                },
                one: { terms: { field: 'pickupPointId', size: 1 } },
              },
            },
          },
        },
        { timeoutMs: READ_TIMEOUT_MS, maxRetries: 0 },
      );
    } catch (error) {
      this.unavailable('clusters', error);
    }
    const buckets =
      (
        res.aggregations?.cells as
          | {
              buckets: {
                key: string;
                doc_count: number;
                center: { location: { lat: number; lon: number } };
                points: { value: number };
                one: { buckets: { key: string }[] };
              }[];
            }
          | undefined
      )?.buckets ?? [];
    return {
      omittedByEngine: buckets.length >= CLUSTER_WINDOW,
      cells: buckets.map((b) => ({
        cellId: b.key,
        offers: b.doc_count,
        pickupPoints: b.points.value,
        lat: b.center.location.lat,
        lng: b.center.location.lon,
        ...(b.points.value === 1 && b.one.buckets[0]
          ? { pickupPointId: b.one.buckets[0].key }
          : {}),
      })),
    };
  }

  async write(
    writes: OfferWrite[],
  ): Promise<{ applied: number; stale: number }> {
    if (writes.length === 0) return { applied: 0, stale: 0 };
    const operations = writes.flatMap((w): object[] => {
      const meta = {
        _index: AVAILABILITY_INDEX,
        _id: w.id,
        version: w.version,
        version_type: 'external_gte' as const,
      };
      return w.document ? [{ index: meta }, w.document] : [{ delete: meta }];
    });
    const res = await this.engine.bulk(operations, {
      timeoutMs: WRITE_TIMEOUT_MS,
      refresh: false,
    });
    let stale = 0;
    let failed = 0;
    for (const item of res.items as Record<
      string,
      { status: number; error?: { type: string } }
    >[]) {
      const result = item.index ?? item.delete;
      if (!result?.error) continue;
      if (result.error.type === 'version_conflict_engine_exception') stale++;
      else if (result.status !== 404) failed++;
    }
    if (failed > 0) {
      PickupMetrics.indexWriteFailures.add(failed);
      throw new Error(`pickup availability bulk: ${failed} failures`);
    }
    return { applied: writes.length - stale, stale };
  }
}
