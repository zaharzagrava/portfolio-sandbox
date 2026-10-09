import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import ShopMembership, {
  ShopRole,
} from '../infra/models/shop-membership.model';
import { CacheService } from '@app/infrastructure/cache/cache.service';

export const membershipCacheKey = (userId: string, shopId: string) =>
  `membership:v1:${userId}:${shopId}`;

/**
 * Membership lookups happen on EVERY shop-scoped request, so they're cached
 * (60 s, negative-cached for non-members); changes invalidate explicitly.
 */
@Injectable()
export class MembershipService {
  constructor(
    @InjectModel(ShopMembership)
    private readonly membershipModel: typeof ShopMembership,
    private readonly cache: CacheService,
  ) {}

  role(userId: string, shopId: string): Promise<ShopRole | null> {
    return this.cache.getOrLoad(
      membershipCacheKey(userId, shopId),
      async () =>
        (
          await this.membershipModel.findOne({
            where: { userId, shopId },
            raw: true,
          })
        )?.role ?? null,
      { ttlMs: 60_000, negativeTtlMs: 10_000, l1: 'hot' },
    );
  }

  invalidate(userId: string, shopId: string): Promise<void> {
    return this.cache.invalidate([membershipCacheKey(userId, shopId)]);
  }
}
