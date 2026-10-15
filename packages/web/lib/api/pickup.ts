import {
  pickupClustersResponseSchema,
  pickupNearSearchResponseSchema,
  pickupPointsNearResponseSchema,
  type PickupClustersResponse,
  type PickupNearSearchResponse,
  type PickupPointsNearResponse,
} from '@marketplace-sandbox/contracts';
import { clampZoom, roundBounds, roundCoords, type Bounds, type Coords } from '@/lib/pickup/coords';
import { DEFAULT_RADIUS_KM, SEARCH_PAGE_SIZE } from '@/lib/search/search-view';
import { parseBody } from './parse';

export type { PickupClustersResponse, PickupNearSearchResponse, PickupPointsNearResponse };

/** Page size of the product page's pickup list (W02 Defaults). */
export const PICKUP_PAGE_SIZE = 10;

type Options = { signal?: AbortSignal };

/**
 * A failed pickup call, shaped like the axios errors `problemFromError` reads (`response.status`, `data`, `headers`). A
 * request that got no answer is thrown as is (no `response`), which reads as status 0, the offline form.
 */
class PickupHttpError extends Error {
  readonly response: { status: number; data: unknown; headers: Record<string, string> };
  constructor(status: number, data: unknown, headers: Record<string, string>) {
    super(`pickup_${status}`);
    this.name = 'PickupHttpError';
    this.response = { status, data, headers };
  }
}

/**
 * The pickup requests carry the visitor's position, so they are asked of the same-origin endpoint straight from the
 * browser and are never cached by the browser or an intermediary (W02 AS-31, FR-043): `cache: 'no-store'`, no
 * credentials needed, and the position only in the query of this one request.
 */
async function getJson(path: string, params: URLSearchParams, signal: AbortSignal | undefined): Promise<unknown> {
  const response = await fetch(`${path}?${params.toString()}`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    referrerPolicy: 'no-referrer',
    signal,
  });
  const text = await response.text().catch(() => '');
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    throw new PickupHttpError(response.status, data, { 'retry-after': response.headers.get('retry-after') ?? '' });
  }
  return data;
}

function withCoords(params: URLSearchParams, coords: Coords, radiusKm: number): void {
  const { lat, lng } = roundCoords(coords);
  params.set('lat', String(lat));
  params.set('lng', String(lng));
  params.set('radiusKm', String(radiusKm));
}

/** `GET /api/search/near` for pickup mode of `/search` (FR-040): only `lat, lng, radiusKm, q, limit, cursor` are sent. */
export async function fetchPickupNearSearch(
  request: { coords: Coords; radiusKm?: number; q?: string; cursor?: string },
  { signal }: Options = {},
): Promise<PickupNearSearchResponse> {
  const params = new URLSearchParams();
  withCoords(params, request.coords, request.radiusKm ?? DEFAULT_RADIUS_KM);
  if (request.q) params.set('q', request.q);
  params.set('limit', String(SEARCH_PAGE_SIZE));
  if (request.cursor) params.set('cursor', request.cursor);
  return parseBody(pickupNearSearchResponseSchema, await getJson('/api/search/near', params, signal));
}

/** `GET /api/pickup-points/near` for the product page's list (FR-070): ten points a page, nearest first. */
export async function fetchPickupPoints(
  request: { productId: string; coords: Coords; radiusKm?: number; cursor?: string },
  { signal }: Options = {},
): Promise<PickupPointsNearResponse> {
  const params = new URLSearchParams();
  withCoords(params, request.coords, request.radiusKm ?? DEFAULT_RADIUS_KM);
  params.set('productId', request.productId);
  params.set('limit', String(PICKUP_PAGE_SIZE));
  if (request.cursor) params.set('cursor', request.cursor);
  return parseBody(pickupPointsNearResponseSchema, await getJson('/api/pickup-points/near', params, signal));
}

/** `GET /api/pickup-points/clusters` for the map (FR-075): bounds to four decimals as `top,left,bottom,right`, integer zoom. */
export async function fetchPickupClusters(
  request: { productId: string; bounds: Bounds; zoom: number },
  { signal }: Options = {},
): Promise<PickupClustersResponse> {
  const { north, west, south, east } = roundBounds(request.bounds);
  const params = new URLSearchParams({
    bbox: [north, west, south, east].join(','),
    zoom: String(clampZoom(request.zoom)),
    productId: request.productId,
  });
  return parseBody(pickupClustersResponseSchema, await getJson('/api/pickup-points/clusters', params, signal));
}
