import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** Aggregate id = `<pickupPointId>:<productId>`, version = PickupStock.version (out-of-order safe indexing). */
export const PickupStockChanged = defineEvent('pickup.stock_changed', 'pickup', 1, z.object({
  pickupPointId: z.string(),
  productId: z.string(),
  shopId: z.string(),
  quantity: z.number().int(),
  lat: z.number(),
  lng: z.number(),
}));
