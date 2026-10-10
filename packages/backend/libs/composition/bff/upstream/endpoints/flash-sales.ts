import {
  flashSalesResponseSchema,
  type FlashSalePublic,
} from '@marketplace-sandbox/contracts';
import { Endpoint } from './endpoint';

/** S11 `GET /api/flash-sales?productIds=`: at most one view per product; the page takes the first or `null`. */
export const flashSalesFor = (
  productIds: readonly string[],
): Endpoint<FlashSalePublic[]> => ({
  name: 'flash_sale',
  upstream: 'flash-sales',
  method: 'GET',
  path: '/api/flash-sales',
  query: { productIds: productIds.join(',') },
  schema: flashSalesResponseSchema,
  identity: 'none',
  sharedCache: true,
  breaker: true,
});
