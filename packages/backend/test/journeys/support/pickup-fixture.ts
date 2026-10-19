import { randomUUID } from 'node:crypto';
import {
  pickupNearSearchResponseSchema,
  pickupPointSchema,
  pickupPointsNearResponseSchema,
  pickupStockAdjustedSchema,
  pickupStockSchema,
  type PickupNearItem,
  type PickupPoint,
} from '@marketplace-sandbox/contracts';
import { API_URL, type JourneyClient } from './journey-client';
import type { FixtureShop } from './catalog-fixture';

/** A pickup point of a shop at a coordinate; the shopper stands about 1.2 km away (0.0108 degrees of latitude). */
export interface PickupSite {
  shop: FixtureShop;
  point: PickupPoint;
  /** Where the shopper is. */
  shopper: { lat: number; lng: number };
}

/** A coordinate unique to this call, so two runs on one stack never see each other's points (L-005, L-006). */
const spot = () => ({
  lat: Number((20 + Math.random() * 40).toFixed(6)),
  lng: Number((-100 + Math.random() * 80).toFixed(6)),
});

/** `POST /shops/:id/pickup-points` at a fresh coordinate; the shopper is 1.2 km north of it. */
export async function createPickupPoint(
  shop: FixtureShop,
  name = 'J04 Point',
): Promise<PickupSite> {
  const { lat, lng } = spot();
  const created = await shop.owner.post(
    `/api/shops/${shop.shopId}/pickup-points`,
    {
      body: { name, address: '1 Journey Street', lat, lng },
      key: randomUUID(),
      schema: pickupPointSchema,
    },
  );
  if (created.status !== 201 && created.status !== 200)
    throw new Error(
      `create pickup point: ${created.status} ${JSON.stringify(created.body)}`,
    );
  return {
    shop,
    point: pickupPointSchema.parse(created.body),
    shopper: { lat: Number((lat + 0.0108).toFixed(6)), lng },
  };
}

/** `PUT …/pickup-points/:pid/stock/:productId` {quantity}. */
export async function setPickupStock(
  site: PickupSite,
  productId: string,
  quantity: number,
) {
  return site.shop.owner.put(
    `/api/shops/${site.shop.shopId}/pickup-points/${site.point.id}/stock/${productId}`,
    {
      body: { quantity },
      key: randomUUID(),
      schema: pickupStockSchema,
    },
  );
}

/** `POST …/stock/:productId/adjustments` {delta} with an `Idempotency-Key`. */
export async function adjustPickupStock(
  site: PickupSite,
  productId: string,
  delta: number,
  key: string = randomUUID(),
) {
  return site.shop.owner.post(
    `/api/shops/${site.shop.shopId}/pickup-points/${site.point.id}/stock/${productId}/adjustments`,
    { body: { delta }, key, schema: pickupStockAdjustedSchema },
  );
}

const nearQuery = (site: PickupSite, q?: string) =>
  new URLSearchParams({
    lat: String(site.shopper.lat),
    lng: String(site.shopper.lng),
    radiusKm: '5',
    ...(q ? { q } : {}),
  }).toString();

/** `GET /search/near` (public, eventually consistent): the offers within 5 km, optionally filtered by `q`. */
export async function searchNear(
  site: PickupSite,
  q?: string,
): Promise<PickupNearItem[]> {
  const response = await fetch(
    `${API_URL}/api/search/near?${nearQuery(site, q)}`,
  );
  if (response.status !== 200)
    throw new Error(`search near: ${response.status} ${await response.text()}`);
  return pickupNearSearchResponseSchema.parse(await response.json()).items;
}

/** `GET /pickup-points/near?productId=` (public, exact): the points that hold the product and their quantity. */
export async function pointsNear(site: PickupSite, productId: string) {
  const response = await fetch(
    `${API_URL}/api/pickup-points/near?${nearQuery(site)}&productId=${productId}`,
  );
  if (response.status !== 200)
    throw new Error(`points near: ${response.status} ${await response.text()}`);
  return pickupPointsNearResponseSchema.parse(await response.json()).items;
}

export type { JourneyClient };
