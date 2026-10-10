import { z } from 'zod';
import { shopSummarySchema } from '@marketplace-sandbox/contracts';
import { Endpoint } from './endpoint';

/**
 * S03 `GET /api/batch/shops?ids=`: ≤ 100 ids, `[{id, name, slug} | null]`, hidden shops `null`. The page shares one
 * answer between visitors (`shared`); a GraphQL request keeps its loads to itself.
 */
export const shopsBatch = (
  ids: readonly string[],
  { shared = true }: { shared?: boolean } = {},
): Endpoint<(z.infer<typeof shopSummarySchema> | null)[]> => ({
  name: 'shop_batch',
  upstream: 'tenancy',
  method: 'GET',
  path: '/api/batch/shops',
  query: { ids: ids.join(',') },
  schema: z.array(shopSummarySchema.nullable()),
  identity: 'none',
  sharedCache: shared,
  breaker: true,
});
