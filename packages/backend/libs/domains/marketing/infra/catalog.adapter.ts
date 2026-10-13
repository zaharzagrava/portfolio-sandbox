import { Injectable } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import type { CatalogPort, ProductFacts } from '../domain/ads-ports';

/**
 * R1 adapter for S05 (D-12): ownership and category of a product at campaign creation come from the catalog's batch
 * lookup with `{shopId}`, never from a SQL read of `Product`. A product of another shop is absent.
 */
@Injectable()
export class CatalogAdapter implements CatalogPort {
  constructor(private readonly products: ProductQueryService) {}

  async getShopProduct(
    productId: string,
    shopId: string,
  ): Promise<ProductFacts | null> {
    const found = await this.products.getProductsByIds([productId], { shopId });
    const product = found.get(productId.toLowerCase());
    if (!product) return null;
    return {
      id: product.id,
      shopId: product.shopId,
      title: product.title,
      category: product.category,
      priceMinor: product.priceMinor,
      currency: product.currency,
      inStock: product.inStock,
      status: product.status,
      isSandbox: product.isSandbox,
      productVersion: product.version,
    };
  }
}
