import { Injectable } from '@nestjs/common';
import type { ShopRole } from '../domain/shop-types';
import { ShopAccessService } from './shop-access.service';

/**
 * Transitional (plan Risk 1): the old `MembershipService.role(userId, shopId)` signature, kept while the consumers
 * (auctions) move to `ShopAccessService.getRole(shopId, userId)`. Delete once `check:table-ownership` and the barrel
 * show no user.
 * @deprecated use `ShopAccessService`
 */
@Injectable()
export class MembershipService {
  constructor(private readonly access: ShopAccessService) {}

  role(userId: string, shopId: string): Promise<ShopRole | null> {
    return this.access.getRole(shopId, userId);
  }
}
