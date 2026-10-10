import { Controller, Get, Module, Req } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { RequestContext } from '@app/infrastructure/context';
import { ShopScoped } from '../api/shop.guard';
import type { ShopRequest } from '../api/shop.guard';
import { SHOP_PERMISSIONS, type ShopPermission } from '../domain/permissions';

/**
 * Routes that exist only in tenancy's own specs: one per permission, resolving the shop from the `X-Shop-Id` header
 * (no path parameter), echoing what the guard put in the request context. Other capabilities guard their routes with
 * the same `ShopScoped`, so this is what "a shop-scoped route" means to the tenancy specs.
 */
function probeController(permission: ShopPermission | undefined) {
  @Controller(`probe/shop/${permission ?? 'member'}`)
  class ShopProbeController {
    constructor(private readonly context: RequestContext) {}

    @ShopScoped(permission)
    @Get()
    handle(@Req() req: ShopRequest) {
      return {
        shopId: req.shopId,
        role: req.shopRole,
        contextShopId: this.context.shopId,
        contextRequestId: this.context.requestId,
      };
    }
  }
  return ShopProbeController;
}

@Module({
  imports: [AuthModule],
  controllers: [
    probeController(undefined),
    ...SHOP_PERMISSIONS.map((p) => probeController(p)),
  ],
})
export class ShopProbeModule {}
