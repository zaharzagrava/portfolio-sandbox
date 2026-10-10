import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from '@app/domains/identity';
import { ROLE_PERMISSIONS, SHOP_PERMISSIONS } from '../domain/permissions';
import { SHOP_ROLES } from '../domain/shop-types';

/** The permission matrix (FR-020), for display in the team screens; the server decides on every request. */
@ApiTags('shops')
@Controller()
export class ShopRolesController {
  @Firewall()
  @Get('shop-roles')
  roles() {
    return {
      roles: Object.fromEntries(
        SHOP_ROLES.map((role) => [role, [...ROLE_PERMISSIONS[role]]]),
      ),
      permissions: [...SHOP_PERMISSIONS],
    };
  }
}
