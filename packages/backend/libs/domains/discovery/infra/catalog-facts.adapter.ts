import { Injectable } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import { ShopQueryService } from '@app/domains/tenancy';
import type {
  CatalogFacts,
  ProductFacts,
} from '../domain/recommendation-ports';
import { RecommendationsSettings } from './recommendations-config';
import { withBudget } from './with-budget';

/**
 * Product and shop facts for a pool of candidates through the entry points of `catalog` (S05) and `tenancy` (S03): one
 * product batch for the whole pool, then one shop batch for the shops of the products found, each under its own budget and
 * never retried (S34 D-7, D-12, R-1). No `ProductModel`, no table of another owner.
 */
@Injectable()
export class CatalogFactsAdapter implements CatalogFacts {
  constructor(
    private readonly products: ProductQueryService,
    private readonly shops: ShopQueryService,
    private readonly settings: RecommendationsSettings,
  ) {}

  async lookup(productIds: string[]): Promise<Map<string, ProductFacts>> {
    const found = await withBudget(
      this.products.getProductsByIds(productIds),
      this.settings.productBudgetMs,
    );
    const shopIds = [...new Set([...found.values()].map((p) => p.shopId))];
    const shops =
      shopIds.length === 0
        ? new Map()
        : await withBudget(
            this.shops.getShopsByIds(shopIds),
            this.settings.shopBudgetMs,
          );
    const facts = new Map<string, ProductFacts>();
    for (const [id, p] of found)
      facts.set(id, {
        title: p.title,
        priceMinor: p.priceMinor,
        currency: p.currency,
        listed:
          p.status === 'ACTIVE' &&
          !p.isSandbox &&
          shops.get(p.shopId)?.status === 'ACTIVE',
        inStock: p.inStock,
      });
    return facts;
  }
}
