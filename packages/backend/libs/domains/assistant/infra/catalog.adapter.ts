import { Injectable } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import type { ProductDirectory, ProductFacts } from '../domain/ports';

/**
 * R1 adapter for S05 (D-12): a product's shop and status come from the catalog's batch lookup, never from a SQL read of
 * `Product`. With `{shopId}` a product of another shop is absent.
 */
@Injectable()
export class CatalogAdapter implements ProductDirectory {
  constructor(private readonly products: ProductQueryService) {}

  async getProducts(
    ids: string[],
    options: { shopId?: string } = {},
  ): Promise<Map<string, ProductFacts>> {
    const found = await this.products.getProductsByIds(ids, options);
    return new Map(
      [...found].map(([id, p]) => [
        id,
        { id: p.id, shopId: p.shopId, status: p.status },
      ]),
    );
  }
}
