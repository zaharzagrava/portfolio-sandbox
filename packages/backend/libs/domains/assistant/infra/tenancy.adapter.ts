import { Injectable } from '@nestjs/common';
import { ShopQueryService } from '@app/domains/tenancy';
import type { ShopDirectory, ShopFacts } from '../domain/ports';

/** R1 adapter for S03: the status of a shop, used to refuse buyer asks on a shop that is not `ACTIVE`. */
@Injectable()
export class TenancyAdapter implements ShopDirectory {
  constructor(private readonly shops: ShopQueryService) {}

  async getShops(ids: string[]): Promise<Map<string, ShopFacts>> {
    const found = await this.shops.getShopsByIds(ids);
    return new Map(
      [...found].map(([id, s]) => [id, { id: s.id, status: s.status }]),
    );
  }
}
