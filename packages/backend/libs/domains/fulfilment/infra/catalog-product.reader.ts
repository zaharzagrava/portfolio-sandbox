import { Injectable } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import type { CatalogProductReader } from '../domain/pickup-ports';
import { ServiceUnavailableError } from '../domain/pickup-errors';

const BUDGET_MS = 500;

/**
 * The catalog's batch read behind an anti-corruption layer (S19 R1, D-7): one product of one shop, asked with the
 * shop filter so a product of another shop is indistinguishable from an unknown one. 500 ms budget, never retried,
 * and never called inside a transaction (the caller reads first).
 */
@Injectable()
export class CatalogProductReaderAdapter implements CatalogProductReader {
  constructor(private readonly products: ProductQueryService) {}

  async findOwned(shopId: string, productId: string) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const found = await Promise.race([
        this.products.getProductsByIds([productId], { shopId }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ServiceUnavailableError()),
            BUDGET_MS,
          );
        }),
      ]);
      const p = found.get(productId);
      if (!p || p.shopId !== shopId) return null;
      return {
        productId: p.id,
        shopId: p.shopId,
        title: p.title,
        category: p.category,
        priceMinor: p.priceMinor,
        currency: p.currency,
        status: p.status,
        isSandbox: p.isSandbox,
        version: p.version,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
