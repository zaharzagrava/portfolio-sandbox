import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { ProductQueryService } from '@app/domains/catalog';
import type { CatalogProduct, ProductCatalogPort } from '../domain/ports';
import { UpstreamUnavailableError } from '../domain/order-errors';
import { withTimeout } from './with-timeout';

/** Prices, currency, status, shop and sandbox flag of the cart's products in one batched read (S05 R1). */
@Injectable()
export class CatalogAdapter implements ProductCatalogPort {
  constructor(
    private readonly products: ProductQueryService,
    private readonly config: ApiConfigService,
  ) {}

  async getProducts(ids: string[]): Promise<Map<string, CatalogProduct>> {
    const found = await withTimeout(
      this.products.getProductsByIds(ids),
      this.config.get('orders_catalog_timeout_ms'),
      () => new UpstreamUnavailableError('catalog'),
    );
    return new Map(
      [...found].map(([id, p]) => [
        id,
        {
          id: p.id,
          shopId: p.shopId,
          title: p.title,
          priceMinor: p.priceMinor,
          currency: p.currency,
          status: p.status,
          isSandbox: p.isSandbox,
          category: p.category,
        },
      ]),
    );
  }
}
