import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';

export const AVAILABILITY_INDEX = 'pickup_availability';

export interface AvailabilityDoc {
  productId: string;
  pickupPointId: string;
  shopId: string;
  title: string;
  category: string;
  price: number;
  quantity: number;
  location: { lat: number; lon: number };
}

export interface NearbyProduct {
  productId: string;
  title: string;
  price: number;
  nearest: { pickupPointId: string; distanceM: number; quantity: number };
}

/**
 * One document per (product, pickup point) WITH stock. Shopper search =
 * text relevance + `geo_distance` filter + collapse on productId (one hit per
 * product, its nearest point via inner_hits) in a single ES query; map pins
 * come from a `geotile_grid` aggregation over the visible bounding box.
 */
@Injectable()
export class AvailabilityIndex implements OnModuleInit {
  private readonly logger = new Logger(AvailabilityIndex.name);

  constructor(private readonly es: SearchEngineClient) {}

  async onModuleInit() {
    const client = this.es.getClient();
    if (
      await client.indices
        .exists({ index: AVAILABILITY_INDEX })
        .catch(() => true)
    )
      return;
    await client.indices
      .create({
        index: AVAILABILITY_INDEX,
        // gc_deletes: versioned-delete tombstones are kept this long, so an older event arriving
        // later than that could re-create a deleted doc - 1 h covers realistic Kafka redelivery lag.
        settings: { refresh_interval: '2s', 'index.gc_deletes': '1h' },
        mappings: {
          properties: {
            productId: { type: 'keyword' },
            pickupPointId: { type: 'keyword' },
            shopId: { type: 'keyword' },
            title: { type: 'text', analyzer: 'english' },
            category: { type: 'keyword' },
            price: { type: 'long' },
            quantity: { type: 'integer' },
            location: { type: 'geo_point' },
          },
        },
      })
      .catch((e) =>
        this.logger.warn(`availability index create: ${e.message}`),
      );
  }

  async searchNear(params: {
    q?: string;
    lat: number;
    lng: number;
    radiusKm: number;
    size?: number;
  }): Promise<NearbyProduct[]> {
    const origin = { lat: params.lat, lon: params.lng };
    const res = await this.es.getClient().search({
      index: AVAILABILITY_INDEX,
      size: params.size ?? 20,
      query: {
        bool: {
          ...(params.q && {
            must: [
              {
                match: {
                  title: {
                    query: params.q,
                    fuzziness: 'AUTO',
                    operator: 'and',
                  },
                },
              },
            ],
          }),
          // Filter context: cached, unscored.
          filter: [
            {
              geo_distance: {
                distance: `${params.radiusKm}km`,
                location: origin,
              },
            },
            { range: { quantity: { gt: 0 } } },
          ],
        },
      },
      sort: params.q
        ? [
            '_score',
            { _geo_distance: { location: origin, order: 'asc', unit: 'm' } },
          ]
        : [{ _geo_distance: { location: origin, order: 'asc', unit: 'm' } }],
      collapse: {
        field: 'productId',
        inner_hits: {
          name: 'nearest',
          size: 1,
          sort: [
            { _geo_distance: { location: origin, order: 'asc', unit: 'm' } },
          ],
        },
      },
    });

    return res.hits.hits.map((hit) => {
      const doc = hit._source as AvailabilityDoc;
      const nearest = (hit.inner_hits?.nearest.hits.hits[0] ?? hit) as {
        _source?: AvailabilityDoc;
        sort?: unknown[];
      };
      return {
        productId: doc.productId,
        title: doc.title,
        price: doc.price,
        nearest: {
          pickupPointId: nearest._source!.pickupPointId,
          distanceM: Math.round(
            Number(nearest.sort?.[nearest.sort.length - 1] ?? 0),
          ),
          quantity: nearest._source!.quantity,
        },
      };
    });
  }

  /** Map clusters: count of in-stock offers per geotile inside the viewport. */
  async clusters(
    bbox: { top: number; left: number; bottom: number; right: number },
    zoom: number,
  ) {
    const res = await this.es.getClient().search({
      index: AVAILABILITY_INDEX,
      size: 0,
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
          ],
        },
      },
      aggs: {
        tiles: {
          geotile_grid: {
            field: 'location',
            precision: Math.min(Math.max(zoom, 0), 20),
          },
          aggs: { center: { geo_centroid: { field: 'location' } } },
        },
      },
    });
    const buckets = (
      res.aggregations?.tiles as {
        buckets: {
          key: string;
          doc_count: number;
          center: { location: { lat: number; lon: number } };
        }[];
      }
    ).buckets;
    return buckets.map((b) => ({
      tile: b.key,
      offers: b.doc_count,
      lat: b.center.location.lat,
      lng: b.center.location.lon,
    }));
  }
}
