import { z } from 'zod';
import {
  productBatchItemSchema,
  productPublicSchema,
} from '@marketplace-sandbox/contracts';
import { Endpoint, enc } from './endpoint';

/** S05 `GET /api/products/:id`: the public view (404 for an unknown, archived or invisible product). */
export const productById = (
  id: string,
): Endpoint<z.infer<typeof productPublicSchema>> => ({
  name: 'product',
  upstream: 'catalog',
  method: 'GET',
  path: `/api/products/${enc(id)}`,
  schema: productPublicSchema,
  identity: 'none',
  sharedCache: true,
  breaker: false,
});

/** S05 `GET /api/batch/products?ids=`: ≤ 100 ids, request order, `null` for invisible items. */
export const productsBatch = (
  ids: readonly string[],
): Endpoint<(z.infer<typeof productBatchItemSchema> | null)[]> => ({
  name: 'product_batch',
  upstream: 'catalog',
  method: 'GET',
  path: '/api/batch/products',
  query: { ids: ids.join(',') },
  schema: z.array(productBatchItemSchema.nullable()),
  identity: 'none',
  sharedCache: false, // GraphQL loads belong to one request (FR-030)
  breaker: true,
});
