import { Injectable } from '@nestjs/common';
import { ShopQueryService } from '@app/domains/tenancy';
import type { ShopDirectory, ShopFacts } from '../domain/ports';

/**
 * Anti-corruption adapter over tenancy's R1 batch read (S03 `ShopQueryService`): the sandbox flag is the one fact
 * billing needs. No `ShopModel`, no membership read, no tenancy SQL (S03 follow-up, constitution IX.4).
 */
@Injectable()
export class TenancyShopDirectoryAdapter implements ShopDirectory {
  constructor(private readonly shops: ShopQueryService) {}

  async facts(shopId: string): Promise<ShopFacts | null> {
    const found = await this.shops.getShopsByIds([shopId]);
    const shop = found.get(shopId);
    return shop ? { isSandbox: shop.isSandbox } : null;
  }
}
