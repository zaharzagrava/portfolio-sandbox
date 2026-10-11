import { z } from 'zod';
import { orderSchema } from '@marketplace-sandbox/contracts';
import { Endpoint, enc } from './endpoint';

/** S10 `GET /api/orders/:orderId` (W03 B-1): the buyer's own order; `404 order_not_found` for a missing or foreign one. */
export const orderById = (
  orderId: string,
): Endpoint<z.infer<typeof orderSchema>> => ({
  name: 'order',
  upstream: 'orders',
  method: 'GET',
  path: `/api/orders/${enc(orderId)}`,
  schema: orderSchema,
  identity: 'required',
  sharedCache: false,
  breaker: false,
});
