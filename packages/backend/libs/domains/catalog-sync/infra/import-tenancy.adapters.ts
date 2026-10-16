import { Injectable } from '@nestjs/common';
import { ShopAccessService, ShopQueryService } from '@app/domains/tenancy';
import type {
  ImportShopAccessPort,
  ImportShopStatusPort,
} from '../domain/ports';

/** Whether the shop may still be written to: tenancy's status through `ShopQueryService` (R1) only. */
@Injectable()
export class TenancyImportShopStatus implements ImportShopStatusPort {
  constructor(private readonly shops: ShopQueryService) {}

  async isActive(shopId: string): Promise<boolean> {
    const shop = (await this.shops.getShopsByIds([shopId])).get(shopId);
    return shop?.status === 'ACTIVE';
  }
}

/**
 * Membership with `products.read` at subscribe time (S51 policy, S07 D-18). Any refusal (not a member, unknown shop,
 * suspended, offboarding) is "no": the topic answers exactly as for an unknown topic.
 */
@Injectable()
export class TenancyImportShopAccess implements ImportShopAccessPort {
  constructor(private readonly access: ShopAccessService) {}

  async canRead(shopId: string, userId: string): Promise<boolean> {
    try {
      await this.access.assertMember(shopId, userId, 'products.read');
      return true;
    } catch {
      return false;
    }
  }
}
