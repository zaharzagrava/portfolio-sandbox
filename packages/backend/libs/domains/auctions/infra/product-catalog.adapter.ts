import { Injectable } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import type {
  CatalogProduct,
  ProductCatalogPort,
} from '../domain/auction-ports';
import { UpstreamUnavailableError } from '../domain/auction-errors';
import { withTimeout } from '../domain/with-timeout';

const CATALOG_TIMEOUT_MS = 1000;

/** The product of a shop through the catalog's exported read service (S05 R1); a product of another shop is absent. */
@Injectable()
export class ProductCatalogAdapter implements ProductCatalogPort {
  constructor(private readonly products: ProductQueryService) {}

  async getProduct(
    shopId: string,
    productId: string,
  ): Promise<CatalogProduct | null> {
    const found = await withTimeout(
      this.products.getProductsByIds([productId], { shopId }),
      CATALOG_TIMEOUT_MS,
      () => new UpstreamUnavailableError('catalog'),
    );
    const p = found.get(productId);
    if (!p || p.shopId !== shopId) return null;
    return {
      id: p.id,
      shopId: p.shopId,
      title: p.title,
      priceMinor: p.priceMinor,
      currency: p.currency,
      quantity: p.quantity,
      status: p.status === 'ACTIVE' ? 'ACTIVE' : 'ARCHIVED',
    };
  }
}
