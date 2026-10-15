import { Injectable } from '@nestjs/common';
import { ShopQueryService } from '@app/domains/tenancy';
import type { ShopDirectory } from '../domain/ports';

/** Anti-corruption adapter over tenancy's R1 batch read (S03 `ShopQueryService`): existence only, nothing else leaks. */
@Injectable()
export class TenancyShopDirectoryAdapter implements ShopDirectory {
  constructor(private readonly shops: ShopQueryService) {}

  async existing(shopIds: string[]): Promise<Set<string>> {
    if (shopIds.length === 0) return new Set();
    const found = await this.shops.getShopsByIds(shopIds);
    return new Set(found.keys());
  }
}
