import { Injectable } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import type { ProductFacts, ProductLookup } from '../domain/ports';

/** S05 R1 `getProductsByIds`: the only way chat learns about a product (no `Product` table, no model; IX.4). */
@Injectable()
export class ProductLookupAdapter implements ProductLookup {
  constructor(private readonly products: ProductQueryService) {}

  async find(productId: string) {
    const p = (await this.products.getProductsByIds([productId])).get(
      productId.toLowerCase(),
    );
    return p
      ? { id: p.id, shopId: p.shopId, title: p.title, status: p.status }
      : null;
  }

  async findMany(productIds: string[]): Promise<Map<string, ProductFacts>> {
    const found = await this.products.getProductsByIds(productIds);
    return new Map(
      [...found].map(([id, p]) => [
        id,
        {
          id: p.id,
          shopId: p.shopId ?? null,
          title: p.title,
          status: p.status,
        },
      ]),
    );
  }
}
