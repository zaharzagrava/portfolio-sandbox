import { z } from 'zod';
import { paymentPageSchema } from '@marketplace-sandbox/contracts';
import { Endpoint } from './endpoint';

/** S13 `GET /api/payments?orderId=&limit=1` (W03 B-2): the newest payment of the buyer's order, never with a secret. */
export const latestPaymentOf = (
  orderId: string,
): Endpoint<z.infer<typeof paymentPageSchema>> => ({
  name: 'payments',
  upstream: 'payments',
  method: 'GET',
  path: '/api/payments',
  query: { orderId, limit: '1' },
  schema: paymentPageSchema,
  identity: 'required',
  sharedCache: false,
  breaker: true,
});
