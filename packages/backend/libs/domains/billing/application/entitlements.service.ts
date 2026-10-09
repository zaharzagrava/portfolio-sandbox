import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { Entitlements } from '../infra/models/plan.model';

/** Free tier when there's no live subscription. */
const FREE_SHOP: Entitlements = {
  maxProducts: 10,
  seats: 1,
  auctions: false,
  apiCallsPerMonth: 1000,
  assistantTokensPerMonth: 0,
};
const FREE_BUYER: Entitlements = {};

export const entitlementsKey = (subjectType: string, subjectId: string) =>
  `entitlements:v1:${subjectType}:${subjectId}`;

/**
 * Features/limits derived from the live subscription (lesson 10/07 #24): the
 * app checks entitlements, never plan names - repackaging plans never touches
 * feature code. Cached; invalidated whenever a subscription changes state.
 * PAST_DUE keeps access (grace period); UNPAID/CANCELED fall back to free.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly cache: CacheService,
  ) {}

  async get(
    subjectType: 'USER' | 'SHOP',
    subjectId: string,
  ): Promise<Entitlements> {
    const loaded = await this.cache.getOrLoad(
      entitlementsKey(subjectType, subjectId),
      async () => {
        const [row] = await this.sequelize.query<{
          entitlements: Entitlements;
        }>(
          `SELECT p.entitlements FROM "Subscription" s JOIN "Price" pr ON pr.id = s."priceId" JOIN "Plan" p ON p.id = pr."planId"
           WHERE s."subjectType" = :subjectType AND s."subjectId" = :subjectId AND s.status IN ('TRIALING','ACTIVE','PAST_DUE')`,
          { type: QueryTypes.SELECT, replacements: { subjectType, subjectId } },
        );
        return (
          row?.entitlements ?? (subjectType === 'SHOP' ? FREE_SHOP : FREE_BUYER)
        );
      },
      { ttlMs: 300_000, l1: 'hot' },
    );
    return loaded ?? {};
  }

  async invalidate(
    subjectType: 'USER' | 'SHOP',
    subjectId: string,
  ): Promise<void> {
    await this.cache.invalidate([entitlementsKey(subjectType, subjectId)]);
  }
}

const ENTITLEMENT_METADATA = 'billing:entitlement';

/**
 * `@RequiresShopEntitlement('auctions')` - place it ABOVE `@ShopScoped(...)`:
 * decorators apply bottom-up, so this guard is appended after ShopGuard and
 * sees the resolved `req.shopId`.
 */
@Injectable()
export class ShopEntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.get<keyof Entitlements>(
      ENTITLEMENT_METADATA,
      context.getHandler(),
    );
    const shopId = context.switchToHttp().getRequest().shopId as
      string | undefined;
    if (!feature) return true;
    // Misconfigured route (no ShopGuard before this guard) → fail closed, never open.
    if (!shopId) throw new ForbiddenException('Shop context required');
    if (!(await this.entitlements.get('SHOP', shopId))[feature])
      throw new ForbiddenException(`Your plan doesn't include "${feature}"`);
    return true;
  }
}

export const RequiresShopEntitlement = (feature: keyof Entitlements) =>
  applyDecorators(
    SetMetadata(ENTITLEMENT_METADATA, feature),
    UseGuards(ShopEntitlementGuard),
  );
