import { Injectable } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import { ShopQueryService } from '@app/domains/tenancy';
import { TrendingDependencyError } from '../domain/trending-errors';
import type {
  TrendingCatalogFacts,
  TrendingProductFacts,
} from '../domain/trending-ports';
import { TrendingSettings } from './trending-config';
import { withBudget } from './with-budget';

/**
 * Product and shop facts of the candidate pool through the entry points of `catalog` (S05) and `tenancy` (S03): one
 * product batch, then one shop batch for the distinct shops found, each under its own budget and never retried (S35 D-7,
 * D-12, R-11). Public data, so no `shopId` option. No `ProductModel`, no table of another owner.
 */
@Injectable()
export class TrendingCatalogFactsAdapter implements TrendingCatalogFacts {
  constructor(
    private readonly products: ProductQueryService,
    private readonly shops: ShopQueryService,
    private readonly settings: TrendingSettings,
  ) {}

  async lookup(
    productIds: string[],
  ): Promise<Map<string, TrendingProductFacts>> {
    const found = await withBudget(
      this.products.getProductsByIds(productIds),
      this.settings.productBudgetMs,
    ).catch((cause: unknown) => {
      throw new TrendingDependencyError('product', cause);
    });
    const shopIds = [...new Set([...found.values()].map((p) => p.shopId))];
    const shops =
      shopIds.length === 0
        ? new Map<string, { status: string }>()
        : await withBudget(
            this.shops.getShopsByIds(shopIds),
            this.settings.shopBudgetMs,
          ).catch((cause: unknown) => {
            throw new TrendingDependencyError('shop', cause);
          });
    const facts = new Map<string, TrendingProductFacts>();
    for (const [id, p] of found)
      facts.set(id, {
        title: p.title,
        priceMinor: p.priceMinor,
        currency: p.currency,
        category: p.category,
        status: p.status,
        isSandbox: p.isSandbox,
        inStock: p.inStock,
        shopStatus: shops.get(p.shopId)?.status ?? null,
      });
    return facts;
  }
}
