import { Inject, Injectable } from '@nestjs/common';
import type {
  ProductBatchItem,
  ProductPublicView,
} from '@marketplace-sandbox/contracts';
import { CacheService, type GetOrLoadOptions } from '@app/infrastructure/cache';
import { PRODUCT_REPOSITORY, type ProductRepository } from '../domain/ports';
import {
  DatabaseUnavailableError,
  isConnectionFailure,
} from '../domain/product-errors';
import { productReadCounter } from '../domain/product-metrics';
import {
  batchItemOf,
  toPublicView,
  type ProductRecord,
} from '../domain/product-view';
import { productCacheKey } from '../infra/product-cache';
import { ProductViewsService } from './product-views.service';

/**
 * Lifetimes of a public entry (SD-34, spec Assumptions): 60 s fresh, 300 s stale-while-revalidate, 10 s for "not
 * found", +-10% jitter so entries written together do not expire together, in-process copy only for hot keys and for
 * at most 1 s, 250 ms per store call. The entry carries its `version` so a versioned invalidation can refuse a late
 * writer (AS-43).
 */
export const PUBLIC_PRODUCT_ENTRY: GetOrLoadOptions<ProductPublicView> = {
  ttlMs: 60_000,
  swrMs: 300_000,
  negativeTtlMs: 10_000,
  jitter: 0.1,
  l1: 'hot',
  l1TtlMs: 1_000,
  timeoutMs: 250,
  versionOf: (view) => view.version,
};

/**
 * Cache-aside reads of the public product (R2): the database is the source of truth, the cache an optimisation that
 * writers delete and never fill. Visibility (FR-013) is decided by the loader's single indexed statement; a hidden
 * product is cached as "not found" for 10 s. A view is counted only after visibility is known.
 */
@Injectable()
export class PublicProductService {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    private readonly cache: CacheService,
    private readonly views: ProductViewsService,
  ) {}

  async getById(id: string): Promise<ProductPublicView | null> {
    let loaded = false;
    const view = await this.cache.getOrLoad<ProductPublicView>(
      productCacheKey(id),
      async () => {
        loaded = true;
        const [record] = await this.load([id]);
        return record ? toPublicView(record) : null;
      },
      PUBLIC_PRODUCT_ENTRY,
    );
    productReadCounter.add(1, {
      outcome: view
        ? loaded
          ? 'miss'
          : 'hit'
        : loaded
          ? 'hidden'
          : 'negative',
    });
    if (view) this.views.count(id);
    return view;
  }

  /** The loader's statement; an unreachable database is a generic 503, never a driver message. */
  private async load(ids: string[]): Promise<ProductRecord[]> {
    try {
      return await this.products.findVisibleByIds(ids);
    } catch (error) {
      if (isConnectionFailure(error)) throw new DatabaseUnavailableError(error);
      throw error;
    }
  }

  /** One store read for all ids and one statement for all misses; `null` for what is not visible. */
  async getBatch(ids: string[]): Promise<Array<ProductBatchItem | null>> {
    const unique = [...new Set(ids)];
    const keys = unique.map(productCacheKey);
    const found = await this.cache.getOrLoadMany<ProductPublicView>(
      keys,
      async (missing) => {
        const wanted = missing.map((key) => unique[keys.indexOf(key)]);
        const records = await this.load(wanted);
        const byId = new Map<string, ProductRecord>(
          records.map((record) => [record.id, record]),
        );
        return new Map(
          missing.map((key, index) => {
            const record = byId.get(wanted[index]);
            return [key, record ? toPublicView(record) : null] as const;
          }),
        );
      },
      PUBLIC_PRODUCT_ENTRY,
    );
    const byId = new Map(unique.map((id, index) => [id, found[index]]));
    return ids.map((id) => {
      const view = byId.get(id) ?? null;
      return view ? batchItemOf(view) : null;
    });
  }
}
