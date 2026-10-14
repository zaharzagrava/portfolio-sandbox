import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import { ShopQueryService } from '@app/domains/tenancy';
import {
  ProductFact,
  ShopFact,
  WidgetCatalog,
  WidgetRandom,
  WidgetShops,
} from '../domain/widget-ports';

/** Products by S05's exported batch lookup with the shop filter (R1): one statement, never a table (FR-015). */
@Injectable()
export class CatalogWidgetCatalog extends WidgetCatalog {
  constructor(private readonly products: ProductQueryService) {
    super();
  }

  async productsOfShop(
    shopId: string,
    ids: string[],
  ): Promise<Map<string, ProductFact>> {
    const found = await this.products.getProductsByIds(ids, { shopId });
    return new Map(
      [...found].map(([id, p]) => [
        id,
        {
          id,
          title: p.title,
          priceMinor: p.priceMinor,
          currency: p.currency,
          inStock: p.inStock,
          status: p.status,
        },
      ]),
    );
  }
}

/** Shops by S03's exported lookup (R1), used when a site is created and by the backfill, never on a public request. */
@Injectable()
export class TenancyWidgetShops extends WidgetShops {
  constructor(private readonly shops: ShopQueryService) {
    super();
  }

  async getShops(ids: string[]): Promise<Map<string, ShopFact>> {
    const found = await this.shops.getShopsByIds(ids);
    return new Map(
      [...found].map(([id, s]) => [
        id,
        { id, name: s.name, status: s.status, shopVersion: s.shopVersion },
      ]),
    );
  }
}

@Injectable()
export class SystemWidgetRandom extends WidgetRandom {
  nonce(): string {
    return randomBytes(16).toString('base64');
  }
}
