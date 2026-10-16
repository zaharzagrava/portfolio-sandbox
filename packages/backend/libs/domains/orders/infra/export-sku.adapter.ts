import { Injectable } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import type { ExportSkuInfo, ExportSkusPort } from '../domain/export-ports';

/** The catalog's `getProductsByIds` accepts at most 500 ids per call. */
export const SKU_LOOKUP_CHUNK = 500;

/**
 * SKU (and the catalog title for legacy lines) through the catalog's exported lookup (S12 FR-013, AS-07): one call per
 * chunk of at most 500 distinct products, scoped to the shop, never one call per line. A product the shop no longer
 * has is absent from the map. A failure surfaces to the caller, which classifies it as a catalog failure.
 */
@Injectable()
export class ExportSkuAdapter implements ExportSkusPort {
  constructor(private readonly products: ProductQueryService) {}

  async lookup(
    shopId: string,
    productIds: string[],
  ): Promise<Map<string, ExportSkuInfo>> {
    const distinct = [...new Set(productIds)];
    const out = new Map<string, ExportSkuInfo>();
    for (let i = 0; i < distinct.length; i += SKU_LOOKUP_CHUNK) {
      const found = await this.products.getProductsByIds(
        distinct.slice(i, i + SKU_LOOKUP_CHUNK),
        { shopId },
      );
      for (const [id, product] of found)
        out.set(id, { sku: product.externalSku, title: product.title });
    }
    return out;
  }
}
