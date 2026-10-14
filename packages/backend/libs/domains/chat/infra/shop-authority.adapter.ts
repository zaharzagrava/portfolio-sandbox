import { Injectable } from '@nestjs/common';
import { ShopAccessService } from '@app/domains/tenancy';
import { AppError } from '@app/common/errors';
import type { ShopAuthority } from '../domain/ports';

/** Answers that mean "not a manager": a stranger to the shop, or a member without the permission. */
const NOT_A_MANAGER = new Set(['shop_not_found', 'permission_denied']);

/**
 * Manager authority is the live shop membership with `products.write` (S03 R1 `assertMember`), asked every time and
 * never cached here (FR-031, AS-54): a person removed from the shop loses control with the next action. A suspended or
 * closing shop is not "not a manager": that answer is the shop's own and passes through.
 */
@Injectable()
export class ShopAuthorityAdapter implements ShopAuthority {
  constructor(private readonly access: ShopAccessService) {}

  async canManage(shopId: string, userId: string): Promise<boolean> {
    try {
      await this.access.assertMember(shopId, userId, 'products.write');
      return true;
    } catch (error) {
      if (error instanceof AppError && NOT_A_MANAGER.has(error.code))
        return false;
      throw error;
    }
  }
}
