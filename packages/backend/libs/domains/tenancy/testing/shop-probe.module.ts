import {
  Controller,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { TenantConnectionResolver } from '../infra/tenant-connection.resolver';
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
function probeController(
  permission: ShopPermission | undefined,
  readWhileClosed = false,
) {
  @Controller(
    `probe/${readWhileClosed ? 'shop-open' : 'shop'}/${permission ?? 'member'}`,
  )
  class ShopProbeController {
    constructor(private readonly context: RequestContext) {}

    @ShopScoped(permission, { readWhileClosed })
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

/** A shop-scoped route that goes to the shop's database cell: the way another domain would use the resolver (AS-54). */
@Controller('probe/cell')
class CellProbeController {
  constructor(private readonly resolver: TenantConnectionResolver) {}

  @ShopScoped('shop.read')
  @Get(':shopId')
  async database(@Param('shopId', ParseUUIDPipe) shopId: string) {
    const connection = await this.resolver.connectionFor(shopId);
    const [row] = await connection.query<{ db: string }>(
      'SELECT current_database() AS db',
      { type: QueryTypes.SELECT },
    );
    return { database: row.db };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [
    CellProbeController,
    probeController(undefined),
    ...SHOP_PERMISSIONS.map((p) => probeController(p)),
    // the routes that opt in to reading a closed shop (the seller dashboard's own reads)
    probeController('products.read', true),
    probeController('orders.read', true),
  ],
})
export class ShopProbeModule {}
