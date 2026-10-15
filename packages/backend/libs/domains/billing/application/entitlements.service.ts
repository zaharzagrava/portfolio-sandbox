import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpStatus,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { AppError, ErrorArea } from '@app/common/errors';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { Entitlements } from '../infra/models/plan.model';
import { UsageService } from './usage.service';

/** Quota keys and the usage metric that counts them (S18 FR-006). */
const QUOTA_METRICS = {
  apiCallsPerMonth: 'api.calls',
  assistantTokensPerMonth: 'llm.assistant.tokens',
} as const;
export type QuotaKey = keyof typeof QUOTA_METRICS;

export interface QuotaStatus {
  allowed: boolean;
  used: number;
  limit: number;
  resetsAt: string;
}

/** Usage could not be read: the caller decides to fail open or closed (S18 AS-08). */
export class Domain_UsageUnavailableError extends AppError {
  constructor() {
    super({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'usage_unavailable',
      title: 'Service Unavailable',
      detail: 'Usage could not be read.',
      area: ErrorArea.TRANSIENT,
    });
  }
}

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
    private readonly usage: UsageService,
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

  /**
   * Minimal provider side of S18 `checkQuota` (FR-006), added by S46 until S18 is built: the plan limit against the exact
   * usage of the current UTC calendar month. Rejects `usage_unavailable` instead of guessing when usage cannot be read.
   */
  async checkQuota(
    subjectType: 'USER' | 'SHOP',
    subjectId: string,
    key: QuotaKey,
    now: Date = new Date(),
  ): Promise<QuotaStatus> {
    const from = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const resetsAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    const limit = (await this.get(subjectType, subjectId))[key] ?? 0;
    const used = await this.usage
      .totalFor(subjectId, QUOTA_METRICS[key], from, resetsAt)
      .catch(() => {
        throw new Domain_UsageUnavailableError();
      });
    return {
      allowed: used < limit,
      used,
      limit,
      resetsAt: resetsAt.toISOString(),
    };
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
 * `403 entitlement_required {feature}` (S18 FR-008, contracts as S21 AS-03 uses them): the shop's plan lacks the
 * feature. The minimal provider side of S18's route guard, added by S21 until S18 is built.
 */
export class Domain_EntitlementRequiredError extends AppError {
  constructor(readonly feature: string) {
    super({
      status: HttpStatus.FORBIDDEN,
      code: 'entitlement_required',
      title: 'Forbidden',
      detail: `Your plan doesn't include "${feature}".`,
      area: ErrorArea.DOMAIN,
      extensions: { feature },
    });
  }
}

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
      throw new Domain_EntitlementRequiredError(feature);
    return true;
  }
}

export const RequiresShopEntitlement = (feature: keyof Entitlements) =>
  applyDecorators(
    SetMetadata(ENTITLEMENT_METADATA, feature),
    UseGuards(ShopEntitlementGuard),
  );
