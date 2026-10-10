import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Firewall } from '@app/domains/identity';
import { RequestContext } from '@app/infrastructure/context';
import { ShopAccessService } from '../application/shop-access.service';
import type { ShopPermission } from '../domain/permissions';
import type { ShopRole } from '../domain/shop-types';
import {
  Domain_ShopMismatchError,
  Domain_ShopNotFoundError,
} from '../domain/errors';
import { authzDeniedCounter } from '../domain/tenancy-metrics';

const SHOP_PERMISSION_METADATA = 'tenancy:permission';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ShopRequest {
  user?: { id: string };
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  shopId?: string;
  shopRole?: ShopRole;
}

/**
 * Resolves the tenant once per request (route `:shopId` or `X-Shop-Id`, never the body), proves the caller is a member
 * and holds the permission, applies the status gate, and puts shopId/role into the request context so logs, events and
 * transactions inherit it. A thin adapter: the decisions are `ShopAccessService`'s. Non-members get 404, not 403: a 403
 * would confirm the shop exists (BOLA).
 */
@Injectable()
export class ShopGuard implements CanActivate {
  constructor(
    private readonly access: ShopAccessService,
    private readonly reflector: Reflector,
    private readonly context: RequestContext,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ShopRequest>();
    const header = req.headers['x-shop-id'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const fromPath = req.params.shopId;
    if (
      fromPath &&
      fromHeader &&
      fromPath.toLowerCase() !== fromHeader.toLowerCase()
    )
      throw new Domain_ShopMismatchError();

    const shopId = fromPath ?? fromHeader;
    if (!shopId || !UUID.test(shopId) || !req.user) {
      authzDeniedCounter.add(1, { reason: 'not_member' });
      throw new Domain_ShopNotFoundError();
    }

    const permission = this.reflector.get<ShopPermission | undefined>(
      SHOP_PERMISSION_METADATA,
      ctx.getHandler(),
    );
    const { role } = await this.access.resolve(
      shopId.toLowerCase(),
      req.user.id,
      permission,
    );

    req.shopId = shopId.toLowerCase();
    req.shopRole = role;
    this.context.set('shopId', req.shopId);
    this.context.set('roles', [role]);
    return true;
  }
}

/** `@ShopScoped('products.write')` = authenticated + member of the shop + permission + status gate. */
export const ShopScoped = (permission?: ShopPermission) =>
  applyDecorators(
    Firewall(),
    SetMetadata(SHOP_PERMISSION_METADATA, permission),
    UseGuards(ShopGuard),
  );
