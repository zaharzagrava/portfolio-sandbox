import { applyDecorators, CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Firewall } from '@app/domains/identity';
import { RequestContext } from '@app/infrastructure/context/request-context.service';
import { MembershipService } from '../application/membership.service';
import { can, ShopPermission } from '../domain/permissions';
import { ShopRole } from '../infra/models/shop-membership.model';

const SHOP_PERMISSION_METADATA = 'tenancy:permission';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ShopRequest {
  user?: { id: string };
  params: Record<string, string>;
  headers: Record<string, string | undefined>;
  shopId?: string;
  shopRole?: ShopRole;
}

/**
 * Resolves the tenant once per request (route `:shopId` or `X-Shop-Id`),
 * VERIFIES the caller is a member (never trusts a tenant id from the client,
 * lesson 10/04 #2), checks the permission, and puts shopId/role into CLS so
 * repositories, logs, jobs and events inherit it.
 * Non-members get 404, not 403: a 403 would confirm the shop exists (BOLA).
 */
@Injectable()
export class ShopGuard implements CanActivate {
  constructor(
    private readonly memberships: MembershipService,
    private readonly reflector: Reflector,
    private readonly context: RequestContext,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ShopRequest>();
    const shopId = req.params.shopId ?? req.headers['x-shop-id'];
    if (!shopId || !UUID.test(shopId) || !req.user) throw new NotFoundException('Shop not found');

    const role = await this.memberships.role(req.user.id, shopId);
    if (!role) throw new NotFoundException('Shop not found');

    const permission = this.reflector.get<ShopPermission | undefined>(SHOP_PERMISSION_METADATA, ctx.getHandler());
    if (permission && !can(role, permission)) throw new ForbiddenException(`Missing permission ${permission}`);

    req.shopId = shopId;
    req.shopRole = role;
    this.context.set('shopId', shopId);
    this.context.set('roles', [role]);
    return true;
  }
}

/** `@ShopScoped('products.write')` = authenticated + member of the shop + permission. */
export const ShopScoped = (permission?: ShopPermission) =>
  applyDecorators(Firewall(), SetMetadata(SHOP_PERMISSION_METADATA, permission), UseGuards(ShopGuard));
