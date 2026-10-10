import {
  pickupPageSchema,
  type PickupPage,
} from '@marketplace-sandbox/contracts';
import { Endpoint } from './endpoint';

/** S19 `GET /api/pickup-points/near?lat&lng&radiusKm&productId&limit`: only with a location. */
export const pickupNear = (args: {
  lat: number;
  lng: number;
  radiusKm: number;
  productId: string;
}): Endpoint<PickupPage> => ({
  name: 'pickup',
  upstream: 'pickup',
  method: 'GET',
  path: '/api/pickup-points/near',
  query: {
    lat: String(args.lat),
    lng: String(args.lng),
    radiusKm: String(args.radiusKm),
    productId: args.productId,
    limit: '5',
  },
  schema: pickupPageSchema,
  identity: 'none',
  sharedCache: true,
  breaker: true,
});
