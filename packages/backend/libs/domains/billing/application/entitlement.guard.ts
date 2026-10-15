import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { entitlementChecksCounter } from '../domain/metrics';
import {
  Domain_EntitlementRequiredError,
  entitlementsUnavailable,
} from '../domain/errors';
import {
  assertEntitlementKey,
  hasEntitlement,
  isEntitlementKey,
} from '../domain/entitlements';
import type { EntitlementKey } from '../domain/entitlements';
import { EntitlementsService } from './entitlements.service';

export const ENTITLEMENT_METADATA = 'billing:entitlement';

/**
 * Denies a shop route (S18 FR-008): `403 entitlement_required {feature}` when the shop's plan lacks the feature,
 * `503 entitlements_unavailable` when the answer cannot be determined (the handler never runs in either case). It
 * trusts `req.shopId`, which only `ShopScoped` sets after membership is proven, so a non-member never learns anything
 * about the shop's plan; `EntitlementGuardValidator` makes a route without that guard impossible to start.
 */
@Injectable()
export class ShopEntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.get<EntitlementKey | undefined>(
      ENTITLEMENT_METADATA,
      context.getHandler(),
    );
    if (!feature) return true;
    const shopId = context.switchToHttp().getRequest().shopId as
      string | undefined;
    // unreachable for a route that passed start-up validation; if it happens, nothing about the shop is revealed
    if (!shopId) throw new NotFoundException();
    let allowed: boolean;
    try {
      // `get` plus the pure check: the same answer as `hasEntitlement`, through the one method other domains fake
      allowed = hasEntitlement(
        await this.entitlements.get('SHOP', shopId),
        feature,
      );
    } catch (error) {
      entitlementChecksCounter.add(1, {
        kind: 'guard',
        outcome: 'unavailable',
      });
      throw (error as { code?: string }).code === 'entitlements_unavailable'
        ? error
        : entitlementsUnavailable();
    }
    if (!allowed) {
      entitlementChecksCounter.add(1, { kind: 'guard', outcome: 'denied' });
      throw new Domain_EntitlementRequiredError(feature);
    }
    entitlementChecksCounter.add(1, { kind: 'guard', outcome: 'ok' });
    return true;
  }
}

/**
 * `@RequiresShopEntitlement('auctions')` - place it ABOVE `@ShopScoped(...)`: decorators apply bottom-up, so this
 * guard is appended after the shop guard and sees the resolved `req.shopId`. A key outside the allowlist is refused
 * where the route is declared.
 */
export const RequiresShopEntitlement = (feature: EntitlementKey) => {
  assertEntitlementKey(feature);
  return applyDecorators(
    SetMetadata(ENTITLEMENT_METADATA, feature),
    UseGuards(ShopEntitlementGuard),
  );
};

/** The shop guard of S03, recognised by name: its class is internal to the tenancy domain (X.4). */
const SHOP_GUARD = 'ShopGuard';

/**
 * Start-up check (S18 AS-10): every handler that carries `RequiresShopEntitlement` must also carry `ShopScoped`
 * before it, and name a key of the allowlist. Application start fails with an error naming the route, so a guard that
 * cannot see a shop is never served.
 */
@Injectable()
export class EntitlementGuardValidator implements OnApplicationBootstrap {
  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    const problems: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const type = wrapper.metatype as (new () => object) | null;
      if (!type?.prototype) continue;
      const classGuards: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, type) ?? [];
      for (const method of methodsOf(type.prototype)) {
        const handler = type.prototype[method] as object;
        const feature = Reflect.getMetadata(ENTITLEMENT_METADATA, handler);
        if (feature === undefined) continue;
        const route = `${type.name}.${method}`;
        if (!isEntitlementKey(feature))
          problems.push(`${route}: "${String(feature)}" is not an entitlement`);
        const guards: unknown[] = [
          ...classGuards,
          ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []),
        ];
        const shop = guards.findIndex(
          (guard) => (guard as { name?: string })?.name === SHOP_GUARD,
        );
        const entitlement = guards.indexOf(ShopEntitlementGuard);
        if (shop < 0 || entitlement < shop)
          problems.push(
            `${route}: RequiresShopEntitlement needs ShopScoped (placed below it) to resolve the shop first`,
          );
      }
    }
    if (problems.length > 0)
      throw new Error(
        `Misconfigured entitlement guard: ${problems.join('; ')}`,
      );
  }
}

function methodsOf(prototype: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (
    let proto: Record<string, unknown> | null = prototype;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  )
    for (const name of Object.getOwnPropertyNames(proto))
      if (name !== 'constructor' && typeof prototype[name] === 'function')
        names.add(name);
  return [...names];
}
