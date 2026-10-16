import type {
  CourierVehicle,
  DeliveryBuyerView,
  DeliveryCourierView,
  DeliveryShopView,
} from '@marketplace-sandbox/contracts';
import type {
  DeliveryHistoryRecord,
  DeliveryRecord,
  LivePosition,
} from './delivery-ports';

/** A courier position older than this is shown with `stale = true` (FR-038). */
export const POSITION_STALE_AFTER_MS = 60_000;

/**
 * Role views as explicit allowlists (V.1, FR-037): each mapper names every field it returns, so a column added to the
 * row never leaks. The buyer never sees the courier id, offer data, attempts or the version; the courier never sees the
 * buyer; the shop never sees the courier or coordinates of the courier.
 */
export function toBuyerView(
  row: DeliveryRecord,
  courier: { vehicle: CourierVehicle; position?: LivePosition | null } | null,
  now: number,
): DeliveryBuyerView {
  const showPosition = row.status === 'ASSIGNED' || row.status === 'PICKED_UP';
  const position = showPosition ? courier?.position : null;
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    pickup: { lat: row.pickup.lat, lng: row.pickup.lng },
    dropoff: { lat: row.dropoff.lat, lng: row.dropoff.lng },
    feeMinor: row.feeMinor,
    currency: row.currency,
    ...(courier &&
      row.courierId && {
        courier: {
          vehicle: courier.vehicle,
          ...(position && {
            position: {
              lat: position.lat,
              lng: position.lng,
              ts: position.ts,
              stale: now - position.ts > POSITION_STALE_AFTER_MS,
            },
          }),
        },
      }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The assigned courier, or the courier holding the live offer (`offerExpiresAt`). */
export function toCourierView(
  row: DeliveryRecord,
  offerExpiresAt: Date | null,
): DeliveryCourierView {
  return {
    id: row.id,
    status: row.status,
    pickup: { lat: row.pickup.lat, lng: row.pickup.lng },
    dropoff: { lat: row.dropoff.lat, lng: row.dropoff.lng },
    feeMinor: row.feeMinor,
    currency: row.currency,
    ...(offerExpiresAt && { offerExpiresAt: offerExpiresAt.toISOString() }),
  };
}

/** `history` only on the detail read; actor ids stay out (a courier id would leak through them). */
export function toShopView(
  row: DeliveryRecord,
  history?: readonly DeliveryHistoryRecord[],
): DeliveryShopView {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    city: row.city,
    pickup: { lat: row.pickup.lat, lng: row.pickup.lng },
    dropoff: { lat: row.dropoff.lat, lng: row.dropoff.lng },
    feeMinor: row.feeMinor,
    currency: row.currency,
    surge: row.surge,
    createdAt: row.createdAt.toISOString(),
    ...(history && {
      history: history.map((entry) => ({
        from: entry.from,
        to: entry.to,
        at: entry.at.toISOString(),
        actorKind: entry.actorKind,
        ...(entry.detail !== null && { detail: entry.detail }),
      })),
    }),
  };
}
