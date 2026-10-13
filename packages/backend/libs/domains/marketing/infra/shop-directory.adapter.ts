import { Injectable } from '@nestjs/common';
import { ShopQueryService } from '@app/domains/tenancy';
import type { ShopDirectoryPort, ShopFacts } from '../domain/ads-ports';

/** R1 adapter for S03: the shop's status and version at campaign creation, used to seed the shop read model (AS-74). */
@Injectable()
export class ShopDirectoryAdapter implements ShopDirectoryPort {
  constructor(private readonly shops: ShopQueryService) {}

  async getShop(shopId: string): Promise<ShopFacts | null> {
    const found = await this.shops.getShopsByIds([shopId]);
    const shop = found.get(shopId);
    return shop
      ? { id: shop.id, status: shop.status, shopVersion: shop.shopVersion }
      : null;
  }
}
