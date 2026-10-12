import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, Role, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { ShopCellService } from '../application/shop-cell.service';
import { ShopLifecycleService } from '../application/shop-lifecycle.service';
import { MoveDirectoryDto, StatusReasonDto } from './tenancy.dto';

const PLATFORM_ADMIN = { roles: [Role.ADMIN], sensitive: true };

/**
 * Platform operator routes over shops (FR-007, FR-050): platform `ADMIN` with a session that is not revoked. They
 * address a shop by id and are not shop-scoped: the caller is not a member.
 */
@ApiTags('admin')
@Controller('admin/shops')
export class AdminShopsController {
  constructor(
    private readonly cells: ShopCellService,
    private readonly lifecycle: ShopLifecycleService,
  ) {}

  @Firewall(PLATFORM_ADMIN)
  @Post(':shopId/suspend')
  @HttpCode(200)
  suspend(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body() body: StatusReasonDto,
  ) {
    return this.lifecycle.suspend(shopId, user.id, body.reason);
  }

  @Firewall(PLATFORM_ADMIN)
  @Post(':shopId/reinstate')
  @HttpCode(200)
  reinstate(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body() body: StatusReasonDto,
  ) {
    return this.lifecycle.reinstate(shopId, user.id, body.reason);
  }

  @Firewall(PLATFORM_ADMIN)
  @Get(':shopId/directory')
  async directory(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.cells.get(shopId);
  }

  @Firewall(PLATFORM_ADMIN)
  @Put(':shopId/directory')
  async move(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body() body: MoveDirectoryDto,
  ) {
    return this.cells.move(shopId, user.id, body);
  }
}
