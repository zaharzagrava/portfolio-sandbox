import DataLoader from 'dataloader';
import { CoreClient, CoreProduct } from '../core-client';

export interface Loaders {
  shop: DataLoader<string, { id: string; name: string; slug: string } | null>;
  product: DataLoader<string, CoreProduct | null>;
}

/**
 * One set of loaders PER GraphQL REQUEST, created in the context factory -
 * not with Nest's REQUEST scope, which would make every provider in the
 * injection chain request-scoped (re-instantiated per request: slow, and
 * easy to get wrong). DataLoader collects all `.load(id)` calls made in the
 * same tick and issues one batch call (N+1 → 1), and caches within the request.
 */
export function createLoaders(core: CoreClient): Loaders {
  return {
    shop: new DataLoader((ids) => core.shops([...ids]), { maxBatchSize: 100 }),
    product: new DataLoader((ids) => core.products([...ids]), {
      maxBatchSize: 100,
    }),
  };
}
